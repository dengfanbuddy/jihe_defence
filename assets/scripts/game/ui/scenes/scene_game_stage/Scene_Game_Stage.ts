import { UnitCfg, UnitCfgContainer } from '../../../excel_table/Tb_UnitConfig';
import { _decorator, Button, Node, UITransform } from 'cc';
import { uiview } from '../../../../platform/ui/UIDecorator';
import { ViewLayer } from '../../../../platform/ui/ViewInfo';
import UIManager from '../../../../platform/ui/UIManager';
import { AdMgr, type AdPlacement } from '../../../../platform/ad/AdMgr';
import { View_Game_Stage } from './cmps/View_Game_Stage';
import { StageScopeEvents, StageScopeKeys } from './cmps/UiScopeKeys';
import BaseView from '../../../../platform/ui/BaseView';

import { useBattleStore } from '../../../stores';

import { BattleContext, EventBus, BattleConstUtil, BattleEvents, StateType } from '../../../battle';
import { EventNames } from '../../../battle/core/EventBus';
import { Entity } from '../../../battle/Entity';
import { DataCenter } from '../../../data';
import { TbRoot } from '../../../../platform/excel_table/TbRoot';
import { AttributeScaling } from '../../../battle/core/AttributeScaling';
import { AttributeType } from '../../../battle/core/Types';
import { MonsterPool } from '../../../game_stage/entityview/MonsterPool';
import { ProjectileViewPool } from '../../../game_stage/entityview/ProjectileViewPool';
import { DamageTextLayer } from '../../../game_stage/entityview/DamageTextLayer';
import { HeroSelect, RelicShop, BuffShop } from '../../../battle';
import { RelicSystem } from '../../../battle/BattleEquipSystem';
import { Ability_LightningChain } from '../../../battle/ScriptedAbilities';
import { Modifier_CounterStorm, Modifier_EagleEye, Modifier_ZeusThunder } from '../../../battle/ScriptedModifiers';
import { pickTarget } from '../../../battle/Targeting';
import { initializeAI } from '../../../battle/ai';
import { GraphCircle } from '../../../common/GraphCircle';
import { UnitKind, getUnitScale, resolveBossKind, FINAL_BOSS_STAGE } from '../../../common/EntityVisualConfig';
import { Hero } from '../../../game_stage/Hero';
import { Scene_Menu } from '../scene_menu/Scene_Menu';

const { ccclass, property } = _decorator;

/**
 * 弹道预制件兜底路径。
 * 美术资源未就位时，所有未显式配置 projectile_prefab / attack_projectile_prefab
 * 的弹道统一用 projectile_1 表现（配置里显式指定的路径优先）。
 */
const DEFAULT_PROJECTILE_PREFAB = 'prefabs/unit/projectiles/projectile_1';


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
  monsterPool: number[];
  /** 肉鸽道具（遗物）池白名单（空 = 商店遗物全表 1001~1293） */
  relicPool: number[];
  spawnInterval: number;
  spawnIntervalMin: number;
  spawnCountStart: number;
  /** 每波刷怪数量上限：数量爬到该值后不再增加（当前 3） */
  spawnCountMax: number;
  /** 数量爬升节奏：每 spawnCountRampWaves 波 +1 只（1 → 2 → 3 的台阶宽度） */
  spawnCountRampWaves: number;
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
  /** 最终 Boss 实体（进入 Boss 阶段时刷出的那一只）；它阵亡 = 通关（见 endRun 的调用点） */
  private finalBoss: Entity | null = null;

  /** 战斗事件是否已订阅到当前 ctx（同一局内换英雄只订阅一次，避免重复发奖励） */
  private eventsBound = false;
  /** 上一次投影到 store 的技能 id 串（只在技能变化时才写 store，避免每帧触发 UI watcher） */
  private lastSkillKey = '';

  battleStore = useBattleStore();

  /* ===================================================================
   * 局内功能三分（选英雄 / 遗物商店 / Buff 商店）—— 本场景只是**宿主**
   *
   * 每个功能一个类（都在 `game/battle/`，纯 TS、无 cc 依赖），场景只做四件事：
   *   ① 持有节点（入口按钮 / 面板节点）—— **节点在谁名下，显隐就由谁写**（绝不跨组件改别人的节点）
   *   ② 把功能类的状态 `provide` 给整棵 UI 子树（键见 `UiScopeKeys`）
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

  /** 遗物入口按钮节点（编辑器拖引用；显隐与点击都由本场景管） */
  @property(Node)
  relicBtnNode: Node = null;
  /** 遗物面板节点（显隐唯一写入口是 applyRelicPanelVisible；面板自己不动自己的节点） */
  @property(Node)
  relicPanelNode: Node = null;

  /** 上一次投影到 store 的背包指纹（只在遗物真的变化时才写 relicBag，避免每次受伤都触发 UI watcher） */
  private lastRelicBagKey = '';

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
    })
    this.relicShop = new RelicShop({
      getBag: () => this.heroRelics,
      getGold: () => this.battleStore.gold,
      spendGold: (amount) => this.spendGold(amount),
      getHeroLevel: () => this.battleStore.level ?? 1,
      getPhase: () => this.stage,
      playAd: (placement) => this.playRewardAd(placement),
    }, () => this.config?.relicPool ?? [])
    this.buffShop = new BuffShop({
      getHero: () => this.hero,
      getGold: () => this.battleStore.gold,
      spendGold: (amount) => this.spendGold(amount),
      playAd: (placement) => this.playRewardAd(placement),
    })

    // 状态向下（provide）：面板 / item 在任意深度 inject 到的都是功能类自己的 ref，只读渲染
    this.scope.provide(StageScopeKeys.HeroSelectList, this.heroSelect.candidates)
    this.scope.provide(StageScopeKeys.HeroSelectPanelVisible, this.heroSelect.panelVisible)
    this.scope.provide(StageScopeKeys.HeroSelectSelectedId, this.heroSelect.selectedId)
    this.scope.provide(StageScopeKeys.HeroSelectRefreshCost, this.heroSelect.refreshCost)
    this.scope.provide(StageScopeKeys.HeroSelectAdFreeLeft, this.heroSelect.adFreeLeft)

    this.scope.provide(StageScopeKeys.RelicPanelVisible, this.relicShop.panelVisible)
    this.scope.provide(StageScopeKeys.RelicSlots, this.relicShop.slots)
    this.scope.provide(StageScopeKeys.RelicRollUsed, this.relicShop.rollUsed)
    this.scope.provide(StageScopeKeys.RelicAdMode, this.relicShop.adMode)
    this.scope.provide(StageScopeKeys.RelicRefreshCost, this.relicShop.refreshCost)
    this.scope.provide(StageScopeKeys.RelicAdFreeLeft, this.relicShop.adFreeLeft)
    
    this.scope.provide(StageScopeKeys.BuffShopPanelVisible, this.buffShop.panelVisible)
    this.scope.provide(StageScopeKeys.BuffShopSlots, this.buffShop.slots)
    this.scope.provide(StageScopeKeys.BuffShopStacks, this.buffShop.stacks)
    this.scope.provide(StageScopeKeys.BuffShopRefreshCost, this.buffShop.refreshCost)
    this.scope.provide(StageScopeKeys.BuffShopAdFreeLeft, this.buffShop.adFreeLeft)

    // 通知向上（scope.on）：面板/item 的 emit 沿 node.parent 冒泡到这里，本场景只做转交，规则全在功能类里
    this.scope.on(StageScopeEvents.HeroRefresh, () => this.heroSelect.refresh(), this)
    this.scope.on(StageScopeEvents.HeroPicked, (heroId: number) => this.heroSelect.pick(heroId), this)
    this.scope.on(StageScopeEvents.RelicRefresh, () => this.relicShop.refresh(), this)
    this.scope.on(StageScopeEvents.RelicPicked, (relicId: number, viaAd: boolean) => this.relicShop.pick(relicId, viaAd), this)
    this.scope.on(StageScopeEvents.BuffShopRefresh, () => this.buffShop.refresh(), this)
    this.scope.on(StageScopeEvents.BuffShopBought, (buffId: number) => this.buffShop.buy(buffId), this)

    // 面板显隐：功能类只写自己的 `panelVisible`，**节点 active 由持有节点的视图写** ——
    //   遗物面板节点在本场景名下 → 这里写；选英雄 / Buff 面板节点在 HUD 名下 → HUD 写（同一组 ref）
    this.scope.watch(() => this.relicShop.panelVisible.value, () => this.applyRelicPanelVisible())

    this.applyRelicPanelVisible()
    // 费用与广告次数的初始投影（面板的置灰判据读它；换局 / 换英雄后还要再同步一次）
    this.relicShop.syncCost()
    this.buffShop.syncCost()
  }

  show() {
    // 重置本局状态
    this.resetRun();
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
   * ⚠ 不调 `endRun()`：**中途退出不算一次对局结束**（不发局外经验、不写 recordGameEnd、不弹面板）。
   * 想让"退出即结算"就把 `endRun('defeat','quit')` 加在这里 —— 但注意那会改变经济口径。
   */
  exit() {
    // 退出副本：先卸载预制件缓存（节点池清空 + resources 引用释放）
    this.monsterPool?.releasePrefabs();
    this.projectilePool?.releasePrefabs();
    this.finished = true;   // 停止本局推进（update 的守卫）；真正的结束收口见 endRun

    UIManager.ins.showUI(Scene_Menu);
  }

  onDestroy(): void {
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
    // 换局：最终 Boss 引用作废（旧 ctx 的实体）
    this.finalBoss = null;

    // this.monsters = [];
    this.spawnIndex = 0
    this.spawnMaxIndex = 5
    this.spawnTimer = this.getSpawnInterval()
    // 每波数量爬升从第 1 波（1 只）重新开始
    this.waveCount = 0

    this.battleStore.reset();
    // 换局：三个功能的界面状态整体复位（面板收起、槽位清空、抽数与广告次数归零）——规则在功能类里
    this.heroSelect?.reset();
    this.relicShop?.reset();
    this.buffShop?.reset();
    this.lastRelicBagKey = '';
    // 换局：普攻锁定目标随战斗上下文作废（避免指向上一局的实体）
    this.attackTarget = null;
    // 换局：战斗事件要在新 ctx 上重新订阅（旧 ctx 的 bus 随旧上下文一起丢弃）
    this.eventsBound = false;
    this.lastSkillKey = '';
    this.lastShownSec = -1;
    // 换局：遗物背包属于「这一局」——旧 ctx 已作废，必须重建（同一局内换英雄才复用，见 selectHero）
    this.heroRelics = null;
    // 清理怪物池（场景重开：隐藏并销毁池中节点，复用逻辑实体清空）
    this.monsterPool?.Clear();
    this.projectilePool?.Clear();
    // 飘字层整场清空（节点保留复用，只退订 + 回收飘字；下一局 initBattle 里重新 bind）
    this.damageText?.unbind();
    this.ctx = null;
  }

  /**
   * 创建 BattleContext（配置由 TbRoot 管线在 Main.start 已加载，见 Tb_*Config.ts）
   */
  private initBattle(): void {
    this.ctx = new BattleContext();
    this.monsterPool = new MonsterPool(this.ctx, this.monsterParent, this.monsterCacheParent);
    this.projectilePool = new ProjectileViewPool();
    // 飘伤害字层：整场一个中央层（层级在预制件里摆好：enimys/hero/弹道之上、UI 之下）
    // 第二个参数 = 参照节点：飘字不做坐标转换，靠"层节点与 monsterParent 同坐标系"这个契约，这里用于自检
    this.ensureDamageTextLayer().bind(this.ctx, this.monsterParent);

    // 注册脚本逃逸口（闪电链等代码类技能 / 鹰眼·反击·雷核等代码类 Modifier）
    this.ctx.scriptRegistry.registerClass('Ability_LightningChain', Ability_LightningChain);
    this.ctx.scriptRegistry.registerClass('Modifier_EagleEye', Modifier_EagleEye);
    this.ctx.scriptRegistry.registerClass('Modifier_CounterStorm', Modifier_CounterStorm);
    this.ctx.scriptRegistry.registerClass('Modifier_ZeusThunder', Modifier_ZeusThunder);

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

  /* ===================================================================
   * 每帧更新（对应 GameManager.tick）
   * =================================================================== */

  update(deltaTime: number): void {
    if (this.battleStore.isPaused) return

    if (!this.ctx || this.finished || !this.hero) {
      // 尚未开局或已结束
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
    this.checkStage(deltaTime);
    // checkStage 可能刚好结束了本局（Boss 阶段倒计时归零）→ 这一帧不再推进战斗
    if (this.finished) return;
    this.tick(deltaTime);
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
      this.stage++
      ezgame.info("进入阶段：", this.stage)
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

    // 1. 刷怪计时（随时间加快）
    this.spawnTimer -= deltaTime;
    if (this.spawnTimer <= 0) {
      this.spawnWave();
      this.spawnTimer = this.getSpawnInterval();
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
    if (isFinal) this.finalBoss = boss;
    console.log(`[战斗] 刷新${isFinal ? '最终' : '阶段'}Boss: ${def.name}（进入阶段 ${stage + 1}, ${kind}, 缩放 ${getUnitScale(kind)}）`)
  }

  /** 单步推进（英雄AI → 弹道表现 → 核心Tick）。胜负不在这一层判，见 endRun */
  private tick(dt: number): void {



    // 3. 英雄 AI（普攻索敌 + 自动施法）
    this.heroAI();



    // 5. 弹道表现：为新发射的弹道创建视图（命中回收由事件驱动）
    this.updateProjectiles();
    // 4. 推进核心战斗系统（Modifier 计时 / DoT / 冷却 / 普攻冷却 / 弹道）
    this.ctx.Tick(dt);

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
    // 战斗事件只订阅一次（同一局 ctx 不变；重复订阅会导致击杀奖励/统计翻倍）
    this.bindBattleEvents();

    // 换英雄：上一任的普攻锁定目标随之作废（新英雄按自己的 attack_targeting 重新锁）
    this.attackTarget = null;

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

    // 遗物面板的费用/广告次数（换局/换英雄后都要重算，面板按它决定刷新按钮置灰）
    this.relicShop?.syncCost();

    // 第一波怪
    // this.shopTimer = this.config.shopEvery;

    // 同步初始状态到 store（UI 读取）
    this.syncHeroToStore();

    console.log(`[战斗] 英雄: ${this.hero.name} @ (${this.config.center.x}, ${this.config.center.y}) 射程 ${this.hero.getAttackRange()}`);

  }

  /**
   * 扣局内金币 —— **三个功能类共用的唯一扣费口**（金币真源是 `hero.gold`）。
   *
   * 由 `HeroSelect` / `RelicShop` / `BuffShop` 通过 `deps.spendGold` 调用；扣完立刻投影到 store
   * （HUD 的金币数字、以及三个面板的置灰判据读的都是 `battleStore.gold`）。
   * 想换货币（比如 Buff 商店改用击杀点）只需要改这一处与 `hero.gold` 的真源，功能类不用动。
   *
   * @returns false = 余额不足（调用方负责拒绝本次操作）
   */
  private spendGold(amount: number): boolean {
    if (!this.hero) return false;
    if ((this.hero.gold ?? 0) < amount) return false;
    this.hero.gold -= amount;
    this.syncHeroToStore();
    return true;
  }

  /** 默认玩法参数（与 BattleDemo 默认一致；id 为 number 配置编号） */
  get defaultConfig(): GameStageConfig {
    return {
      heroUnitId: 1002, // 赏金猎人（hero 1000 段：1001 火枪 / 1002 赏金 / 1003 宙斯 / 1004 斧王）
      monsterPool: [2001, 2002, 2003, 2004, 2005, 2006], // 哥布林/巨魔/游荡者/环绕魔/重击者/深渊领主
      relicPool: [], // 空 = 商店遗物全表（293 件道具，id 1001~1293）
      spawnInterval: 2.5,
      spawnIntervalMin: 1.0,
      // 每波数量爬升：第 1~4 波 1 只 → 第 5~8 波 2 只 → 第 9 波起 3 只（前期压力小，逐步加码）
      spawnCountStart: 1,
      spawnCountMax: 3,
      spawnCountRampWaves: 4,
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
      prepareTime: 10,
      stageTime: 60,
      bossTime: 60,
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
      }
      // 最终 Boss 阵亡 → 通关。放在统计/奖励**之后**，让这一杀算进本局结算（击杀数 / 掉金）
      if (e.entity === this.finalBoss) {
        this.finalBoss = null; // 实体已回池，引用作废（防复用时误判）
        this.endRun('victory', 'boss_killed')
      }
    });
    // 英雄受伤/治疗 → 投影到 store（UI 血条）；唯一写入口 syncHeroToStore
    this.ctx.bus.onBattleEvent(BattleEvents.OnTakeDamage, (e: any) => {
      if (e.target === this.hero) this.syncHeroToStore();
    });
    this.ctx.bus.onBattleEvent(BattleEvents.OnHeal, (e: any) => {
      if (e.target === this.hero) this.syncHeroToStore();
    });
    // 遗物记录
    this.ctx.bus.onBattleEvent(BattleEvents.OnRelicAdded, (e: any) => {
      if (e.target === this.hero) {
        this.syncHeroToStore();
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
   * 击杀奖励（金币 / 经验）
   * =================================================================== */

  /**
   * 击杀奖励发放：
   *   实际奖励 = 基地值（units.json 的 goldReward/expReward） × 阶段难度系数 × 时间通胀系数
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

    // 专门 boss：一次性大量奖励（相对常规 boss 的倍率加成）
    if (def.rewardType === 'gold_boss') {
      gold = Math.round(gold * BattleConstUtil.getRewardBossGoldBonus());
    } else if (def.rewardType === 'exp_boss') {
      exp = Math.round(exp * BattleConstUtil.getRewardBossExpBonus());
    }

    if (gold <= 0 && exp <= 0) return;

    // 金币：局内经济（HUD 读取 battleStore.gold，由 syncHeroToStore 投影）。
    // 局外金币不属于局内经济体系，此处不写 DataCenter。
    if (gold > 0) {
      this.hero.gold = (this.hero.gold ?? 0) + gold;
      this.syncHeroToStore();
    }

    // 经验：局内英雄等级（升级→加属性）。不是局外经验！
    if (exp > 0) {
      this.addBattleExp(exp);
    }

    console.log(`[奖励] 击杀 ${def.name}: 金币 +${gold}, 局内经验 +${exp} (敌人奖励缩放 x${scale.toFixed(2)})`);
  }

  /* ===================================================================
   * 局内英雄等级 / 经验（非局外数据中心）
   * =================================================================== */

  /**
   * 局内经验：累加到当前出战英雄，满了就升级。
   * 升级时按 units.json 的 growthValues 调 attrs.addBase 加属性，并同步 HUD。
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
      // 升级后属性（含 maxHp）已变化：当前血补满新上限，并刷新 HUD
      this.hero.hp = this.hero.getMaxHp();
      this.hero.mana = this.hero.getMaxMana();
      this.syncHeroToStore();
      console.log(`[局内] 英雄升级到 Lv.${st.level}`);
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
   * 当前奖励缩放系数：
   *   阶段难度系数 = 1 + difficultyMultiplier 进度（阶段越高越难，奖励越高）
   *   时间通胀系数 = 1 + min(elapsed × 每秒系数, 上限)
   * 二者相乘：跨阶段靠难度跳，阶段内靠时间缓涨。
   */
  private currentRewardScale(): number {
    // 阶段难度（0 准备、1-4 常规、5 boss）。这里用阶段序号近似难度增益。
    const phaseMul = 1 + Math.max(0, this.stage - 1) * 0.15;
    const timeMul = 1 + Math.min(this.elapsed * BattleConstUtil.getRewardTimeBasePerSec(), BattleConstUtil.getRewardTimeCap());
    return phaseMul * timeMul;
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
   * 唯一例外是嘲讽（hero.forcedTarget），它压过锁定（见 resolveAttackTarget）。
   *
   * 重置时机：换英雄（selectHero）/ 本局重开（resetRun）/ 锁定目标死亡（OnDeath）。
   * 注意：实体回对象池后会被复用成"另一只怪"，所以旧引用必须在这三处作废。
   */
  private attackTarget: Entity | null = null;

  /**
   * 每帧的普攻决策：返回本帧该打的敌人（null = 本帧不出手）
   *
   * 优先级：
   *   ① 强制目标（嘲讽）：只要还活着就优先，**不看射程挑别人** ——
   *      射程外返回 null（站原地等它靠近），但锁定不换；
   *      目标死亡/被回收时强制状态自动解除，落回 ②③。
   *   ② 粘性锁定：锁定目标仍存活、可选中、在射程内 → 继续打它（不重新比较）。
   *   ③ 重新索敌：按 attack_targeting 在射程内挑一个（挑不到就保留锁定，等它回射程）。
   *
   * @param strategy 索敌策略（units.json 的 attack_targeting，缺省 nearest），仅在 ③ 生效
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

    // ② 粘性锁定：目标没死就继续打，不做任何重新比较
    const locked = this.attackTarget;
    if (locked && this.isTargetUsable(locked) && this.isInRange(locked, range)) return locked;

    // ③ 锁定失效（死亡/回收/不可选中）或离开射程 → 重新索敌
    const next = this.pickEnemy(strategy, range);
    if (next) {
      this.attackTarget = next;
      return next;
    }
    // 射程内没有别的敌人：锁定目标若已失效就清掉，否则保留（它可能马上回到射程内）
    if (locked && !this.isTargetUsable(locked)) this.attackTarget = null;
    return null;
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
   * 刷怪 / 商店
   * =================================================================== */

  /** 从四周刷新一波怪物 */
  private spawnWave(): void {

    const [rMin, rMax] = this.config.spawnRadius;
    // const pool = this.elapsed < 15
    //   ? this.config.monsterPool.filter((id) => id === 2001) // 前 15s 只刷哥布林(2001)
    //   : this.config.monsterPool.filter((id) => !(id === 2006 && this.elapsed < 60)); // 60s 后才出 Boss(2006)

    let monsterId = 2001

    let aliveNum = this.battleStore.enemiesAlive
    // 本波数量 = min(波次爬升后的数量, 场上还能容纳的数量)；容不下就少刷或不刷
    const bornCount = Math.min(this.getWaveSpawnCount(), Math.max(0, 50 - aliveNum));
    if (bornCount <= 0) {
      return
    }
    let born = 0;
    for (let i = 0; i < bornCount; i++) {
      // const defId = pool[Math.floor(Math.random() * pool.length)];
      const defId = monsterId;
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

    if (born > 0) {
      // 只有真的刷出来了才算一波（被存活上限卡住时不推进，避免"空波"把数量台阶提前）
      this.waveCount++;
      console.log(`[战斗] 第 ${this.waveCount} 波刷新 ${born} 只怪物 (场上 ${this.ctx.activeEntityCount() - 1}, 逻辑池空闲 ${this.monsterPool.idleCount()})`);
    }
  }

  /** 已刷出的波次（spawnWave 实际刷出怪物才 +1），用于"每波数量爬升" */
  private waveCount = 0;

  /**
   * 本波刷几只 —— **前期少、逐步加码**：1 → 2 → 3（上限 spawnCountMax）
   *
   * 公式：count = clamp(spawnCountStart + floor(波次 / spawnCountRampWaves), start, max)
   * 默认 start=1 / max=3 / rampWaves=4 → 第 1~4 波 1 只、第 5~8 波 2 只、第 9 波起 3 只。
   * 想更快加码就把 spawnCountRampWaves 调小（3 或 2），想更平缓就调大。
   */
  private getWaveSpawnCount(): number {
    const start = Math.max(1, this.config.spawnCountStart);
    const max = Math.max(start, this.config.spawnCountMax);
    const step = Math.max(1, this.config.spawnCountRampWaves);
    return Math.min(max, start + Math.floor(this.waveCount / step));
  }
  spawnIndex = 0;
  spawnMaxIndex = 6
  spawnGap = [0,3, 3, 2, 2, 1.7, 1.7, 1.2, 0.7]
  private getSpawnInterval(): number {
    //刷怪间隔，随时间变化
    //默认0.5 每次击杀防守boss减少0.15
    // const shrink = Math.floor(this.elapsed / 25) * 0.3;
    // return Math.max(this.config.spawnIntervalMin, this.config.spawnInterval - shrink);
    // this.battleStore.addEnergy
    //3 3 2 2 1.7 1.7 
    let gap = this.spawnGap[this.spawnIndex]
    if(this.spawnIndex<this.spawnMaxIndex){
      this.spawnIndex++
    }
    return gap
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
    if (this.relicPanelNode) this.relicPanelNode.active = this.relicShop.panelVisible.value;
  }

  /**
   * 拉起激励视频广告 —— 本场景提供给 `RelicShop` 的**平台能力**（`playAd` 依赖）。
   *
   * 播放期间把本局置为暂停（广告回来再恢复原状态）—— 广告是覆盖全屏的原生层，
   * 不暂停的话玩家回来会发现自己已经被怪打死了。
   *
   * 平台 SDK 由接入方通过 `AdMgr.inst.setProvider(...)` 注入；未接入时 `AdMgr` 走**开发兜底**
   * （打 warn 并按「看完」返回 true），保证编辑器里能把整条广告流程跑通。
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

    console.log(`========== 战斗结算 ==========\n结果: ${result}（${reason}） 存活 ${this.elapsed.toFixed(0)}s\n击杀: ${this.killCount}\n金币: ${Math.floor(this.hero?.gold ?? 0)}`);

    // 局外经验结算：按配置一次性发（不累加局内击杀经验）。
    // 局内英雄等级仅是局内成长，局终清零，不写入局外数据中心。
    this.settleMetaRewards(this.victory);

    this.battleStore.isGameOver = true;
    EventBus.emit(EventNames.BATTLE_ENDED, { result, reason });

    // 弹结算面板（面板数据后续再补）；玩家点「确定」才回主界面（见 View_Game_Stage.exit）
    this.uiView?.showEnd(this.victory);
  }

  /**
   * 局外经验结算（对局结束一次性发，按配置）。
   * 金币/经验 boss 与局内击杀经验都只在局内生效；此处仅发放「通关配置经验」，
   * 与局内击杀经验完全解耦。英雄名 → HeroData 对应英雄做局外升级。
   */
  private settleMetaRewards(victory: boolean): void {
    let ct = TbRoot.ins.getTbContainer(UnitCfgContainer)

    const heroCfg = ct.getCfgById(this.hero.id);
    const heroName = heroCfg?.name ?? this.hero?.name ?? '';
    //发奖励规则：
    //1.胜利 奖励局内最后选择的英雄经验，跟难度没关系，
    // 配置基数：胜利按 100%，失败按 30%（参与度补偿）
    const ratio = victory ? 1.0 : 0.3;
    const playerExp = Math.round(BattleConstUtil.getClearRewardPlayerExpBase() * ratio);
    const heroExp = Math.round(BattleConstUtil.getClearRewardHeroExpBase() * ratio);

    // 玩家全局经验（局外，跨局累积）
    const leveledUp = DataCenter.ins.playerInfo.addExp(playerExp);

    // 英雄局外经验：HeroData 以数字 heroId 为键、不存名字，
    // 这里取第一个已解锁英雄兜底（局外英雄经验至少进账一笔）。
    const heroId = this.firstHeroId();
    const heroLeveledUp = heroId !== null ? DataCenter.ins.heroData.addHeroExp(String(heroId), heroExp) : false;

    DataCenter.ins.playerInfo.recordGameEnd(this.killCount, this.stage);
    DataCenter.ins.saveAll();

    console.log(`[局外结算] 玩家 +${playerExp} 经验${leveledUp ? '（升级）' : ''}；英雄[${heroName}] +${heroExp} 经验${heroLeveledUp ? '（升级）' : ''}`);
  }

  /** 取第一个已解锁英雄的 heroId（HeroData 不存名字，无法按名称精确匹配） */
  private firstHeroId(): number | null {
    const heroes = DataCenter.ins.heroData.data.heroes;
    // for (const info of Object.values(heroes)) {
    //   if (info) return info.id;
    // }
    return null;
  }

  /* ===================================================================
   * 对外查询
   * =================================================================== */

  isFinished(): boolean { return this.finished; }
  isVictory(): boolean { return this.victory; }
  getElapsed(): number { return this.elapsed; }
  getKillCount(): number { return this.killCount; }
  getCurrentPhase(): number { return 1; }
}
