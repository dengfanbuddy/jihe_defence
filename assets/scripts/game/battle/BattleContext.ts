import { EventBus } from './EventBus';
import { DamagePipeline } from './DamagePipeline';
import { EffectExecutor } from './EffectExecutor';
import { Entity } from './Entity';
import { Projectile } from './Projectile';
import { SpatialGrid } from './SpatialGrid';
import { BattleEvents } from './types';
import { AIRegistry } from './ai/AIRegistry';
import { AttributeType } from './core/Types';
import { BattleConstUtil } from './core/BattleConstUtil';
import type { AttributeCfg } from '../excel_table/Tb_AttributeConfig';
import type { ModifierCfg } from '../excel_table/Tb_ModifierConfig';
import type { AbilityCfg } from '../excel_table/Tb_AbilityConfig';
import type { RelicCfg } from '../excel_table/Tb_RelicConfig';
import type { UnitCfg } from '../excel_table/Tb_UnitConfig';
import { TbRoot } from '../../platform/excel_table/TbRoot';
import { AttributeCfgContainer } from '../excel_table/Tb_AttributeConfig';
import { ModifierCfgContainer } from '../excel_table/Tb_ModifierConfig';
import { AbilityCfgContainer } from '../excel_table/Tb_AbilityConfig';
import { RelicCfgContainer } from '../excel_table/Tb_RelicConfig';
import { UnitCfgContainer } from '../excel_table/Tb_UnitConfig';

/** 定时任务（简易调度器，供配置动作使用） */
interface ScheduledTask {
    remaining: number;
    callback: () => void;
}

/**
 * 脚本注册表 —— 配置与代码的桥（逃逸口）
 * script_id → 类（Modifier/Ability）或函数（动作）
 * 复杂逻辑在这里注册，配置中通过 script_id 引用。
 */
export class ScriptRegistry {
    private classes = new Map<string, any>();
    private actions = new Map<string, (target: any, self: any, params: any) => void>();

    /** 注册代码类（用于 Modifier/Ability 的 script_id） */
    registerClass(id: string, cls: any): void { this.classes.set(id, cls); }
    /** 注册动作函数（用于 execute_script 动作） */
    registerAction(id: string, fn: (target: any, self: any, params: any) => void): void { this.actions.set(id, fn); }

    get(id: string): any | undefined { return this.classes.get(id); }
    getAction(id: string): ((target: any, self: any, params: any) => void) | undefined { return this.actions.get(id); }
    has(id: string): boolean { return this.classes.has(id) || this.actions.has(id); }
}

/**
 * BattleContext —— 战斗上下文（单场战斗的容器）
 * 持有：事件总线、伤害管线、实体表、调度器
 * 配置：不直接持有配置数据，通过 TbRoot 全局管线查询（Tb_*Config 容器）
 */
export class BattleContext {
    readonly bus = new EventBus();
    readonly damagePipeline: DamagePipeline;
    /** 效果执行器：所有配置化动作（伤害/治疗/Buff/偷钱...）的唯一入口 */
    readonly effects: EffectExecutor;
    readonly scriptRegistry = new ScriptRegistry();

    /** 飞行中的弹道列表（两阶段结算） */
    projectiles: Projectile[] = [];

    /** 实体表 */
    entities = new Map<number, Entity>();
    private nextEntityId = 1;

    /** 已回收实体集合（对象池中，不在战斗逻辑中；查询方法自动排除） */
    private recycledEntities = new Set<Entity>();

    /** 简易调度器 */
    private tasks: ScheduledTask[] = [];
    private spatialMap: Entity[] = [];

    /** 实体分离（软碰撞）用均匀网格：近邻查询加速 */
    private spatialGrid = new SpatialGrid();
    /** 是否启用实体分离（防重叠） */
    separationEnabled = true;
    /** 每帧分离迭代次数（越大越贴合间距、越耗 CPU；2 足够） */
    separationIterations = 2;

    /** 战斗累计时间（秒） */
    time = 0;

    constructor() {
        this.damagePipeline = new DamagePipeline(this);
        this.effects = new EffectExecutor(this);
    }

    // ============ 配置查询（走 TbRoot 管线，不持有数据） ============

    /** 属性容器（TbRoot 全局实例） */
    get attributeContainer(): AttributeCfgContainer {
        return TbRoot.ins.getTbContainer(AttributeCfgContainer);
    }
    /** Modifier 容器 */
    get modifierContainer(): ModifierCfgContainer {
        return TbRoot.ins.getTbContainer(ModifierCfgContainer);
    }
    /** 技能容器 */
    get abilityContainer(): AbilityCfgContainer {
        return TbRoot.ins.getTbContainer(AbilityCfgContainer);
    }
    /** 遗物容器 */
    get relicContainer(): RelicCfgContainer {
        return TbRoot.ins.getTbContainer(RelicCfgContainer);
    }
    /** 单位容器 */
    get unitContainer(): UnitCfgContainer {
        return TbRoot.ins.getTbContainer(UnitCfgContainer);
    }

    /** 属性定义表（兼容旧引用；新代码优先用容器/查询方法） */
    get attributeDefs(): Map<number, AttributeCfg> {
        const m = new Map<number, AttributeCfg>();
        for (const c of this.attributeContainer.cfgs) m.set(c.id, c);
        return m;
    }
    /** Modifier 定义表（兼容旧引用） */
    get modifierDefs(): Map<number, ModifierCfg> {
        const m = new Map<number, ModifierCfg>();
        for (const c of this.modifierContainer.cfgs) m.set(c.id, c);
        return m;
    }
    /** 技能定义表（兼容旧引用） */
    get abilityDefs(): Map<number, AbilityCfg> {
        const m = new Map<number, AbilityCfg>();
        for (const c of this.abilityContainer.cfgs) m.set(c.id, c);
        return m;
    }
    /** 遗物定义表（兼容旧引用） */
    get relicDefs(): Map<number, RelicCfg> {
        const m = new Map<number, RelicCfg>();
        for (const c of this.relicContainer.cfgs) m.set(c.id, c);
        return m;
    }
    /** 单位定义表（兼容旧引用） */
    get unitDefs(): Map<number, UnitCfg> {
        const m = new Map<number, UnitCfg>();
        for (const c of this.unitContainer.cfgs) m.set(c.id, c);
        return m;
    }

    /** 查询单个属性定义 */
    getAttributeDef(id: number): AttributeCfg | undefined {
        return this.attributeContainer.getCfgById(id);
    }
    /** 查询单个 Modifier 定义 */
    getModifierDef(id: number): ModifierCfg | undefined {
        return this.modifierContainer.getCfgById(id);
    }
    /** 查询单个技能定义 */
    getAbilityDef(id: number): AbilityCfg | undefined {
        return this.abilityContainer.getCfgById(id);
    }
    /** 查询单个遗物定义 */
    getRelicDef(id: number): RelicCfg | undefined {
        return this.relicContainer.getCfgById(id);
    }
    /** 查询单个单位定义 */
    getUnitDef(id: number): UnitCfg | undefined {
        return TbRoot.ins.getTbContainer(UnitCfgContainer).getCfgById(id);
    }

    // ============ 实体创建 ============

    /**
     * 从 UnitCfg 创建实体（纯配置驱动）
     */
    CreateEntityFromDef(def: UnitCfg): Entity {
        const entity = new Entity(
            def.id,
            this.nextEntityId++,
            def.name,
            def.team,
            this,
            def.base_attributes,
        );
        entity.Reinit(def);
        this.AddEntity(entity);
        return entity;
    }

    /** 手动创建实体（代码驱动） */
    CreateEntity(name: string, team: number, initialBaseAttrs?: Array<[number, number]>): Entity {
        const id = this.nextEntityId++;
        const entity = new Entity(id, id, name, team, this, initialBaseAttrs);
        this.AddEntity(entity);
        return entity;
    }

    /**
     * 实体加入战斗上下文（入战：可被 AI 索敌 / Tick 推进 / 范围查询）
     * 发布 OnEntityAdded 事件，统计由订阅方（stage/UI）负责
     */
    AddEntity(entity: Entity): void {
        // 若是从回收状态回来，清除回收标记（统一由 ctx 管理）
        this.recycledEntities.delete(entity);
        this.entities.set(entity.uid, entity);
        this.spatialMap.push(entity);
        this.bus.publish(BattleEvents.OnEntityAdded, { entity });
    }

    /**
     * 实体移出战斗上下文（出战：回收/移除）
     * 发布 OnEntityRemoved 事件，统计由订阅方负责
     */
    RemoveEntity(entity: Entity): void {
        this.entities.delete(entity.uid);
        const idx = this.spatialMap.indexOf(entity);
        if (idx >= 0) this.spatialMap.splice(idx, 1);
        // 统一标记为已回收（对象池持有期间不参与战斗逻辑）
        this.recycledEntities.add(entity);
        this.bus.publish(BattleEvents.OnEntityRemoved, { entity });
    }

    /** 实体当前是否已回收（对象池中） */
    IsRecycled(entity: Entity): boolean {
        return this.recycledEntities.has(entity);
    }

    /** 取消回收标记（实体再次入战时由 AddEntity 自动处理；显式调用用于异常兜底） */
    Unrecycle(entity: Entity): void {
        this.recycledEntities.delete(entity);
    }

    /** 当前场上活跃实体数（回收中的不计） */
    activeEntityCount(): number {
        return this.spatialMap.length;
    }

    /** 按实例 uid 查询实体（不含已回收的） */
    GetEntity(uid: number): Entity | undefined { return this.entities.get(uid); }

    /** 获取某队伍的所有存活实体（不含已回收的） */
    GetTeamEntities(team: number): Entity[] {
        const res: Entity[] = [];
        for (const e of this.spatialMap) {
            if (e.team === team && !e.IsDead()) res.push(e);
        }
        return res;
    }

    /** 获取所有实体（含死亡、不含已回收，供多目标弹道等全量筛选） */
    GetAllEntities(): Entity[] {
        return [...this.spatialMap];
    }

    /** 简化范围查询（真实项目用空间分区；这里线性遍历；不含已回收） */
    findEntitiesInRadius(center: any, radius: number, teamFilter?: number): Entity[] {
        const cx = center?.position?.x ?? 0;
        const cy = center?.position?.y ?? 0;
        const r2 = radius * radius;
        return this.spatialMap.filter((e) => {
            if (e.IsDead()) return false;
            if (teamFilter !== undefined && e.team !== teamFilter) return false;
            const dx = (e.position?.x ?? 0) - cx;
            const dy = (e.position?.y ?? 0) - cy;
            return dx * dx + dy * dy <= r2;
        });
    }

    // ============ 实体分离（软碰撞，防重叠） ============

    /**
     * 实体分离 —— 每帧在 AI 移动后调用，把重叠的实体沿连线推开，防止敌人堆叠。
     *
     * 为什么需要：ChaseAI/WanderAI 都朝英雄（同一点）移动，多只怪会收敛到同一
     * 位置从而重叠。这里做"软碰撞"：对每个重叠实体对，按可移动性分配推开量。
     *
     * 设计要点：
     *   - 英雄（immovable=true）视为锚点：只推别人，不被别人推动
     *   - 均匀网格做近邻查询（近似 O(n)），控住大规模怪群的性能
     *   - 每帧 iterations 次迭代，配合持续移动逐步收敛，避免一帧瞬移抖动
     *
     * 调参：碰撞半径 → battle_constants.json 的 collisionRadiusDefault /
     * 单位表 units.json 的 collision_radius；推开强度 → separationStrength。
     */
    separateEntities(iterations: number = this.separationIterations): void {
        if (!this.separationEnabled) return;

        // 收集存活、可分离的实体 + 估算最大碰撞半径（决定网格 cell 大小）
        const alive: Entity[] = [];
        let maxRadius = 0;
        for (const e of this.spatialMap) {
            if (e.IsDead() || e.collisionRadius <= 0) continue;
            alive.push(e);
            if (e.collisionRadius > maxRadius) maxRadius = e.collisionRadius;
        }
        if (alive.length < 2) return;

        // 均匀网格：cell 边 = 2 * 最大半径，保证 3x3 邻域能覆盖任意一对重叠实体
        const cellSize = Math.max(32, maxRadius * 2);
        this.spatialGrid.setCellSize(cellSize);
        this.spatialGrid.clear();
        for (const e of alive) this.spatialGrid.insert(e);

        const strength = BattleConstUtil.getSeparationStrength();
        for (let it = 0; it < iterations; it++) {
            for (const e of alive) {
                const neighbors = this.spatialGrid.getNeighbors(e);
                for (const other of neighbors) {
                    if (other === e || other.IsDead() || other.collisionRadius <= 0) continue;
                    // uid 排序保证每对只处理一次，避免同一帧内互相重复结算
                    if (e.uid >= other.uid) continue;

                    const dx = other.position.x - e.position.x;
                    const dy = other.position.y - e.position.y;
                    let dist = Math.hypot(dx, dy);
                    const minDist = e.collisionRadius + other.collisionRadius;
                    if (dist >= minDist) continue;

                    // 单位方向（严格重合时随机取一轴，避免除零）
                    let nx: number, ny: number;
                    if (dist < 1e-4) {
                        const a = Math.random() * Math.PI * 2;
                        nx = Math.cos(a);
                        ny = Math.sin(a);
                    } else {
                        nx = dx / dist;
                        ny = dy / dist;
                    }
                    const overlap = minDist - dist;

                    // 按可移动性分配推开量：锚点（英雄）一动不动，完全由对方承担
                    const eAnchored = this.isAnchored(e);
                    const oAnchored = this.isAnchored(other);
                    if (eAnchored && oAnchored) continue; // 两个锚点互不推开

                    let eShare = 0.5, oShare = 0.5;
                    if (eAnchored) { eShare = 0; oShare = 1; }
                    else if (oAnchored) { eShare = 1; oShare = 0; }

                    const push = overlap * strength;
                    if (eShare > 0) {
                        e.position.x -= nx * push * eShare;
                        e.position.y -= ny * push * eShare;
                    }
                    if (oShare > 0) {
                        other.position.x += nx * push * oShare;
                        other.position.y += ny * push * oShare;
                    }
                }
            }
        }
    }

    /**
     * 是否为锚点（分离时不动、只负责推开别人的实体）。
     * 仅显式标记 `immovable` 的实体（如英雄/防守点）作为锚点；
     * 玩家方召唤物等可灵活移动的单位默认不锚定，正常参与分离。
     */
    isAnchored(e: Entity): boolean {
        return e.immovable;
    }

    // ============ 调度器 ============

    /** 延时执行 */
    schedule(delay: number, callback: () => void): void {
        this.tasks.push({ remaining: delay, callback });
    }

    // ============ 弹道管理（两阶段结算） ============

    /** 发射弹道（延迟结算：飞行到达后才命中） */
    spawnProjectile(projectile: Projectile): void {
        this.projectiles.push(projectile);
    }

    // ============ 战斗循环 ============

    /** 每帧更新（dt 秒）。所有实体 + 弹道 + 调度器 + 时间推进。 */
    Tick(dt: number): void {
        this.time += dt;
        for (const e of this.spatialMap) e.Tick(dt);
        // AI 移动后做实体分离（软碰撞），防止敌人重叠
        this.separateEntities();

        // 弹道推进：到达 → 对齐终点 → 命中结算 → 移除
        const arrived: Projectile[] = [];
        for (const p of this.projectiles) {
            if (p.tick(dt)) arrived.push(p);
        }
        if (arrived.length > 0) {
            this.projectiles = this.projectiles.filter((p) => !arrived.includes(p));
            for (const p of arrived) {
                p.snapToEnd(); // 逻辑位置对齐终点（表现层同步读到）
                p.onHit();
            }
        }

        for (const t of [...this.tasks]) {
            t.remaining -= dt;
            if (t.remaining <= 0) t.callback();
        }
        this.tasks = this.tasks.filter((t) => t.remaining > 0);
    }
}
