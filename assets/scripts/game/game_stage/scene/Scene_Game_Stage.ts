import { UnitCfg, UnitCfgContainer } from './../../excel_table/Tb_UnitConfig';
import { _decorator, Node } from 'cc';
import { uiview } from '../../../platform/ui/UIDecorator';
import { ViewLayer } from '../../../platform/ui/ViewInfo';
import UIManager from '../../../platform/ui/UIManager';
import { View_Game_Stage } from '../ui/View_Game_Stage';
import BaseView from '../../../platform/ui/BaseView';

import { useBattleStore } from '../../stores';
import { Scene_Menu } from '../../scene/scene_prefab/Scene_Menu';

import { BattleContext, EventBus, BattleConstUtil, BattleEvents } from '../../battle';
import { EventNames } from '../../battle/core/EventBus';
import { Entity } from '../../battle/Entity';
import { DataCenter } from '../../data';
import { TbRoot } from '../../../platform/excel_table/TbRoot';
import { AttributeScaling } from '../../battle/core/AttributeScaling';
import { AttributeType } from '../../battle/core/Types';
import { MonsterPool } from '../entityview/MonsterPool';
import { ProjectileViewPool } from '../entityview/ProjectileViewPool';
import { ShopSystem, ShopOption } from '../../battle/ShopSystem';
import { RelicSystem } from '../../battle/BattleEquipSystem';
import { Ability_LightningChain } from '../../battle/ScriptedAbilities';
import { pickTarget } from '../../battle/Targeting';
import { initializeAI } from '../../battle/ai';
import { Hero } from '../Hero';

const { ccclass, property } = _decorator;

/**
 * Scene_Game_Stage.ts — 游戏战斗场景（总控，相当于 GameManager）
 *
 * 职责（迁移自 ts_combat_system/demo/GameManager.ts）：
 *   1. 配置加载 → BattleContext 初始化（attributes/modifiers/abilities/relics/units）
 *   2. 创建英雄（居中守点）+ 遗物系统 + 肉鸽商店
 *   3. 刷怪（随时间加快）/ 怪物 AI（朝中心移动 + 自动普攻）
 *   4. 英雄 AI（普攻索敌 + 自动施放 CD 就绪技能）
 *   5. 每帧驱动 BattleContext.Tick（Modifier 计时 / DoT / 冷却 / 弹道）
 *   6. 定期开商店（rollOptions 交给 UI，autoChoose 仅作 Demo 兜底）
 *   7. 胜负判定（英雄死亡 = 失败，存活 winTime = 胜利）
 *
 * 与 FSM 状态机配合：HeroSelection（选英雄）→ Battle（战斗中）→ Pause（暂停）
 */

/** 玩法参数（BattleDemo 对应项，可整段调整；id 均为 number） */
export interface GameStageConfig {
  heroUnitId: number;
  monsterPool: number[];
  skillPool: number[];
  relicPool: number[];
  spawnInterval: number;
  spawnIntervalMin: number;
  spawnCountStart: number;
  spawnRadius: [number, number];
  shopEvery: number;
  winTime: number;
  maxSkillSlots: number;
  killHeal: number;
  center: { x: number; y: number };
}

@uiview({
  prefabPath: 'prefabs/scenes/Scene_Game_Stage',
  layer: ViewLayer[ViewLayer.Scene],
  single: true,
})
@ccclass('Scene_Game_Stage')
export class Scene_Game_Stage extends BaseView<null, null> {


  /** 战斗上下文（核心，纯 TS 无 cc 依赖） */
  ctx!: BattleContext;


  /* ===== 战斗实体 ===== */
  /** 玩家控制的英雄（Entity，居中心不移动） */
  hero: Entity = null;
  /** 当前在场的所有怪物 */
  // private monsters: Entity[] = [];

  /* ===== 肉鸽系统 ===== */
  heroRelics!: RelicSystem;
  shop!: ShopSystem;

  /* ===== 怪物统一对象池（组合逻辑池 + 表现池） ===== */
  monsterPool!: MonsterPool;
  /** 弹道表现层对象池 */
  projectilePool!: ProjectileViewPool;

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

  /** 商店选项缓存（UI 层读取并选择） */
  shopOptions: ShopOption[] = [];

  battleStore = useBattleStore();

  @property(Node)
  uiViewNode: Node
  uiView: View_Game_Stage

  /* ===================================================================
   * Cocos 生命周期
   * =================================================================== */

  onLoad(): void {
    this.uiView = this.uiViewNode.getComponent(View_Game_Stage)
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
    EventBus.on(EventNames.BATTLE_SELECT_HERO, (payload) => this.selectHero(payload));


    // 加载战斗配置（attributes/modifiers/abilities/relics/units）
    this.initBattle();
    this.uiView.init(this.ctx)
    // 阶段/剩余时间改为写 store，UI 通过响应式 watch 订阅（单一来源，替代 BATTLE_REMAINTIME 事件）
    this.battleStore.phase = this.stage
    this.battleStore.phaseRemainTime = this.stageRemainTime
    this.battleStore.showSelectHeroPanel = true
  }

  close() {
    EventBus.off(EventNames.BATTLE_EXIT);
    EventBus.off(EventNames.BATTLE_SELECT_HERO);
    this.uiView.unInit()
  }

  start(): void {
    // 空实现（BaseView 约定）
  }

  exit() {
    // 退出副本：先卸载预制件缓存（节点池清空 + resources 引用释放）
    this.monsterPool?.releasePrefabs();
    this.projectilePool?.releasePrefabs();
    this.finished = true;
    EventBus.clear();
    UIManager.ins.showUI(Scene_Menu);
  }

  onDestroy(): void {
    if (this.ctx) this.ctx.bus.clear();
  }

  /* ===================================================================
   * 初始化（对应 GameManager.init）
   * =================================================================== */

  private resetRun(): void {
    this.elapsed = 0;
    this.stage = 0
    this.stageRemainTime = 10
    this.finished = false;
    this.victory = false;
    this.killCount = 0;

    // this.monsters = [];
    this.spawnIndex = 0
    this.spawnMaxIndex = 5
    this.spawnTimer = this.getSpawnInterval()

    this.shopOptions = [];
    this.battleStore.reset();
    // 清理怪物池（场景重开：隐藏并销毁池中节点，复用逻辑实体清空）
    this.monsterPool?.Clear();
    this.projectilePool?.Clear();
    this.ctx = null;
  }

  /**
   * 创建 BattleContext（配置由 TbRoot 管线在 Main.start 已加载，见 Tb_*Config.ts）
   */
  private initBattle(): void {
    this.ctx = new BattleContext();
    this.monsterPool = new MonsterPool(this.ctx, this.monsterParent, this.monsterCacheParent);
    this.projectilePool = new ProjectileViewPool();

    // 注册脚本逃逸口（闪电链等代码类技能）
    this.ctx.scriptRegistry.registerClass('Ability_LightningChain', Ability_LightningChain);

    // 注册怪物 AI（chase/wander/orbit/attack_stop/boss）
    initializeAI();

    // 战斗常量刷新（battle_constants.json）
    BattleConstUtil.markLoaded();

    // 预加载本局所有可能用到的预制件（怪物 + 弹道），避免战斗中首帧卡顿
    // this.preloadBattleAssets();

    // console.log('[战斗] BattleContext 就绪，单位配置数:', this.ctx.unitContainer.size);
  }

  gameEnd(success:false){
    this.finished = true
    this.victory = false
    this.uiView.showEnd(null)
  }

  /**
   * 预加载本局会用到的全部表现预制件：
   *   - 所有怪物/英雄单位 prefab（units 表）
   *   - 普攻弹道 prefab（attack_projectile_prefab）
   *   - 技能弹道 prefab（含 projectile 效果的技能，projectile_prefab）
   * 战斗开始时同步触发（异步加载进缓存，战斗中 acquire 命中缓存零延迟）
   */
  private preloadBattleAssets(): void {
    if (!this.ctx || !this.monsterPool || !this.projectilePool) return;
    const monsterPaths: string[] = [];
    const projectilePaths: string[] = [];

    // 1. 单位预制件 + 普攻弹道（全部单位，含未启用的 boss，避免阶段切换时才加载）
    for (const def of this.ctx.unitContainer.cfgs) {
      if (def.prefab) monsterPaths.push(def.prefab);
      if (def.attack_projectile_prefab) projectilePaths.push(def.attack_projectile_prefab);
    }

    // 2. 技能弹道（全部技能，含商店池可能抽到的）
    for (const def of this.ctx.abilityContainer.cfgs) {
      if (def.projectile_prefab) projectilePaths.push(def.projectile_prefab);
    }

    this.monsterPool.preload(monsterPaths, (loaded, total) => {
      console.log(`[战斗] 预加载怪物预制件 ${loaded}/${total}`);
    });
    this.projectilePool.preload(projectilePaths, (loaded, total) => {
      console.log(`[战斗] 预加载弹道预制件 ${loaded}/${total}`);
    });
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
    if (this.hero.IsDead()) {
      console.log("英雄死亡！")
      return
    }
    this.checkStage(deltaTime);
    this.tick(deltaTime);
  }
  /** 上一次通知 UI 的整秒数：仅整秒变化时才广播，避免跳秒 */
  private lastShownSec = -1
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
    }
    if (this.stageRemainTime == 0) {
      if (this.stage == 5) {//boss阶段超时未击杀，失败
        this.finished = true
        this.victory = false
        this.gameEnd(false)
        //TODO 弹出结算面板
        return
      }
      this.spawnBoss(this.stage)
      //进入下一阶段
      this.stage++
      ezgame.info("进入阶段：", this.stage)
      this.stageRemainTime = 60
      if (this.stage == 5) {//boss战限时120s
        this.stageRemainTime = 60
      }

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
    //刷新阶段boss
    console.log("刷新阶段boss:" + stage)
  }

  /** 单步推进（刷怪 → 怪物AI → 英雄AI → 核心Tick → 弹道表现 → 商店 → 胜负） */
  private tick(dt: number): void {



    // 3. 英雄 AI（普攻索敌 + 自动施法）
    this.heroAI();



    // 5. 弹道表现：为新发射的弹道创建视图（命中回收由事件驱动）
    this.updateProjectiles();
    // 4. 推进核心战斗系统（Modifier 计时 / DoT / 冷却 / 普攻冷却 / 弹道）
    this.ctx.Tick(dt);

    // 6. 商店计时
    // this.shopTimer -= dt;
    // if (this.shopTimer <= 0) {
    //   this.openShop();
    //   this.shopTimer = this.config.shopEvery;
    // }

    // 7. 胜负判定
    // this.checkEnd();
  }

  /**
   * 弹道表现管理：
   *   - 遍历 ctx.projectiles，为还没有视图的弹道创建 ProjectileView
   *   - 预制件路径从配置读取：
   *       普攻弹道 → 单位配置 unitDef.attack_projectile_prefab
   *       技能弹道 → 技能配置 abilityDef.projectile_prefab
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

  /** 解析弹道预制件路径（配置驱动：优先单位普攻弹道，其次技能弹道） */
  private resolveProjectilePrefab(p: any): string | null {
    // 普攻弹道（isAttack=true）→ 攻击者单位配置
    if (p.isAttack) {
      const src = p.source;
      // source 可能是 Entity；其 id 是单位配置 id
      if (src?.id !== undefined) {
        const def = this.ctx?.getUnitDef(src.id);
        if (def?.attack_projectile_prefab) return def.attack_projectile_prefab;
      }
      return null;
    }
    // 技能弹道 → 技能配置
    const ability = p.ability;
    if (ability?.def?.projectile_prefab) return ability.def.projectile_prefab;
    // 兜底：按弹道 id 命名约定
    return `prefabs/projectiles/ability_${p.ability?.def?.id ?? ''}`;
  }

  /* ===================================================================
   * 英雄选择 / 创建
   * =================================================================== */

  selectHero(payload: { ID: number | string }) {
    if (!this.ctx) {
      console.warn('[战斗] 配置未就绪，忽略选英雄');
      return;
    }
    // 传数字（UI 英雄列表的 id）或字符串（unit id 名称兜底）
    // let heroId = Number(payload.ID);
    let heroId = 3;
    // 选中英雄必须是 team=1 的英雄；英雄选择列表可能含非英雄单位(如怪兽 id4)，非法时回退到默认英雄
    const picked = this.ctx.getUnitDef(heroId);
    if (!picked || picked.team !== 1) heroId = this.config?.heroUnitId ?? 1;
    const def = this.ctx.getUnitDef(heroId) ?? this.ctx.getUnitDef(this.config?.heroUnitId ?? 1);
    if (!def) {
      console.error(`[战斗] 未找到英雄配置: ${payload.ID}`);
      return;
    }

    // 创建英雄（居中守点，不移动）
    let hero = this.heroNode.getComponent(Hero)
    // 局内等级每次选英雄都从 1 级开始（局内体系，局终清零）
    this.resetHeroLevel();
    if (hero.entity) {
      // 复用英雄实体：旧实体的 ctx 指向上一局，必须重建并挂到新上下文
      const oldEntity = hero.entity;
      this.ctx.RemoveEntity(oldEntity);
      // 用新上下文重建英雄（CreateEntityFromDef 内部 AddEntity + Reinit）
      this.hero = this.ctx.CreateEntityFromDef(def);
      this.hero.position = { ...this.config.center };
      this.hero.immovable = true; // 英雄为锚点：实体分离时只推怪不推英雄
      hero.bind(this.hero);
      // 新 ctx 需要重新订阅战斗事件（旧订阅绑的是上一局 bus）
      this.bindBattleEvents();
      // TODO 等级，经验，当前血量重新辅助（迁移 oldEntity 的持久数据）
    } else {
      this.hero = this.ctx.CreateEntityFromDef(def);
      this.hero.position = { ...this.config.center };
      this.hero.immovable = true; // 英雄为锚点：实体分离时只推怪不推英雄
      hero.bind(this.hero)
      // 订阅战斗事件（击杀回血 / 英雄状态同步到 store）
      this.bindBattleEvents();
    }




    // 遗物系统 + 商店系统
    // this.heroRelics = new RelicSystem(this.hero, this.ctx);
    // this.shop = new ShopSystem(this.hero, this.ctx, this.heroRelics, {
    //   skillPool: this.config.skillPool,
    //   relicPool: this.config.relicPool,
    //   maxSlots: this.config.maxSkillSlots,
    // });


    // 第一波怪
    // this.shopTimer = this.config.shopEvery;

    // 同步初始状态到 store（UI 读取）
    this.syncHeroToStore();

    console.log(`[战斗] 英雄: ${this.hero.name} @ (${this.config.center.x}, ${this.config.center.y})`);

  }

  /** 默认玩法参数（与 BattleDemo 默认一致；id 为 number 配置编号） */
  get defaultConfig(): GameStageConfig {
    return {
      heroUnitId: 3, // hero_bounty
      monsterPool: [4, 5, 6, 7, 8, 9], // goblin/troll/wanderer/orbiter/brute/boss
      skillPool: [1, 2, 4, 5], // fireball/frost_nova/war_cry/lightning_chain
      relicPool: [2, 1, 3, 4], // vampiric_fang/thorn_armor/flame_sword/giant_heart
      spawnInterval: 2.5,
      spawnIntervalMin: 1.0,
      spawnCountStart: 1,
      spawnRadius: [650, 800],
      shopEvery: 20,
      winTime: 90,
      maxSkillSlots: 3,
      killHeal: 6,
      center: { x: 0, y: 0 },
    };
  }

  /** 注入玩法参数（外部可在 show 前调用覆盖默认值） */
  setGameConfig(partial: Partial<GameStageConfig>): void {
    this.config = { ...this.defaultConfig, ...partial };
  }

  private bindBattleEvents(): void {
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
      if(e.entity==this.hero){//英雄死亡    
        this.gameEnd(false)
        return
      }
      // 非英雄死亡 → 回收进对象池（ctx 统一管理回收状态，防重复回收）
      if (e.entity !== this.hero && !this.ctx.IsRecycled(e.entity)) {
        this.recycleMonster(e.entity);
      }
      if (e.killer === this.hero && e.entity !== this.hero) {
        this.killCount++;
        this.hero.Heal(this.config.killHeal);
        this.battleStore.onEnemyKilled();
        this.grantKillReward(e.entity);
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

  /** 英雄状态同步到 battleStore（UI 响应式读取） */
  private syncHeroToStore(): void {
    if (!this.hero) return;
    this.battleStore.hp = this.hero.hp;
    this.battleStore.maxHp = this.hero.getMaxHp();
    this.battleStore.gold = this.hero.gold;
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
   *   ⚠️ 不写局外 DataCenter——局外经验在对局结束 finish() 时按配置一次性结算。
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
   * 按 units.json 英雄条目的 growthValues 给英雄加一级属性。
   * 英雄配置来源单位配置（units.json，team=1 的 id 1/2/3），与英雄实体 this.hero.id 一致。
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

    // 4.1 普攻（普通攻击，不算技能：独立于技能体系，带冷却，索敌策略 = 普攻的 targeting）
    const attackAbility = this.hero.abilities.getAttackAbility();
    const attackStrategy = attackAbility?.def.targeting ?? 'nearest';
    const target = this.pickEnemy(attackStrategy, attackRange);
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

  /** 按策略在范围内选目标 */
  private pickEnemy(strategy: string, range: number): Entity | null {
    const center = this.config.center;
    const enemies = this.ctx.GetTeamEntities(2).filter((e) => {
      const dx = e.position.x - center.x;
      const dy = e.position.y - center.y;
      return dx * dx + dy * dy <= range * range;
    });
    return pickTarget(strategy as any, enemies, center) as Entity | null;
  }

  /* ===================================================================
   * 刷怪 / 商店
   * =================================================================== */

  /** 从四周刷新一波怪物（前 15s 只刷弱怪） */
  private spawnWave(): void {

    // const count = Math.min(
    //   this.config.spawnCountStart + Math.floor(this.elapsed / 70),
    //   3,
    // );
    const [rMin, rMax] = this.config.spawnRadius;
    // const pool = this.elapsed < 15
    //   ? this.config.monsterPool.filter((id) => id === 4) // 前 15s 只刷哥布林(4)
    //   : this.config.monsterPool.filter((id) => !(id === 9 && this.elapsed < 60)); // 60s 后才出 Boss(9)

    let monsterId = 4

    let aliveNum = this.battleStore.enemiesAlive
    let bornCount = 50 - aliveNum;
    bornCount = bornCount > 3 ? 3 : bornCount
    if (bornCount == 0) {
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

    if (born > 0) console.log(`[战斗] 刷新 ${born} 只怪物 (场上 ${this.ctx.activeEntityCount() - 1}, 逻辑池空闲 ${this.monsterPool.idleCount()})`);
  }
  spawnIndex = 0;
  spawnMaxIndex = 5
  spawnGap = [3, 3, 2, 2, 1.7, 1.7, 1.2, 0.7]
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

  /** 开启肉鸽商店：抽 3 选 1（选项缓存到 shopOptions，由 UI 选择） */
  private openShop(): void {
    const options = this.shop.rollOptions(3);
    this.shopOptions = options;
    console.log(`【商店】选项: ${options.map((o) => o.name).join(' / ')}`);

    // Demo 兜底：没有 UI 选择时自动装备第一个可装备项
    const result = this.shop.autoChoose(options);
    if (result) {
      const chosen = options.find((o) => this.shop.canEquip(o));
      console.log(`【商店】${result === 'upgraded' ? '升级' : '获得'} ${chosen?.name ?? ''}`);
    } else {
      console.log('【商店】没有可装备的选项');
    }
    this.syncHeroToStore();
  }

  /** UI 选择商店选项（由商店面板调用） */
  chooseShopOption(option: ShopOption): boolean {
    if (!this.shop) return false;
    const result = this.shop.equip(option);
    if (result) {
      console.log(`【商店】${result === 'upgraded' ? '升级' : result === 'relic' ? '获得遗物' : '装备'} ${option.name}`);
      this.syncHeroToStore();
      return true;
    }
    return false;
  }

  /* ===================================================================
   * 胜负判定（对应 GameManager.checkEnd）
   * =================================================================== */

  private checkEnd(): void {
    if (this.finished) return;
    if (this.hero.IsDead()) {
      this.finish(false);
      return;
    }
    if (this.elapsed >= this.config.winTime) {
      this.finish(true);
    }
  }

  private finish(victory: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.victory = victory;
    console.log(`========== 战斗结算 ==========\n结果: ${victory ? '胜利 🏆' : '失败 💀'} (存活 ${this.elapsed.toFixed(0)}s)\n击杀: ${this.killCount}\n金币: ${Math.floor(this.hero?.gold ?? 0)}`);

    // 战斗结束：卸载预制件缓存（节点池清空 + resources 引用释放）
    this.monsterPool?.releasePrefabs();
    this.projectilePool?.releasePrefabs();

    // 局外经验结算：按配置一次性发（不累加局内击杀经验）。
    // 局内英雄等级仅是局内成长，局终清零，不写入局外数据中心。
    this.settleMetaRewards(victory);

    this.battleStore.isGameOver = true;
    EventBus.emit(EventNames.BATTLE_ENDED, { result: victory ? 'victory' : 'defeat' });

    // 回到主菜单（后续可接结算 UI）
    UIManager.ins.showUI(Scene_Menu);
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
    for (const info of Object.values(heroes)) {
      if (info) return info.id;
    }
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
