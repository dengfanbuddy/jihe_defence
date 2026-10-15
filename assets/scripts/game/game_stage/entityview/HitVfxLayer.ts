import { _decorator, Color, Component, Graphics, Node, UITransform } from 'cc';
import { BattleEvents } from '../../battle';
import type { BattleContext } from '../../battle';
import { UnitKind } from '../../common/EntityVisualConfig';
import {
    HIT_FEEL_BUDGET,
    HIT_FEEL_MARK,
    HIT_FEEL_SHAPE,
    HIT_FEEL_TIER_RANK,
    HitFeelTier,
    HitMarkSpec,
    HitShapeKind,
    HitShapeResult,
    clampBattleDt,
    getShapeSpec,
    getTierSpec,
    resolveDeathTier,
    resolveHitShape,
    resolveHitTier,
} from '../../common/HitFeelConfig';
import { HitFeelDirector } from './HitFeelDirector';
import type { SkillShapeReport } from '../../battle/SkillShape';
const { ccclass } = _decorator;

/** 本层 UITransform 的覆盖尺寸（战场以原点为中心、刷怪半径 ≤ 800，取 4000 留足余量） */
const COVER_SIZE = 4000;

/**
 * 一个形态图形最多存几个落点（像素对，所以是 2×）。
 *
 * 取 12：`audit` 与实机的链式弹射最多 4~5 跳，12 已经留足余量；
 * 而天怒那种全场爆炸有 20+ 个落点 —— 存下来只为算包围盒，画的时候也不需要更多点。
 */
const SHAPE_POINT_MAX = 12;

/**
 * ============================================================
 * HitVfxLayer —— 图纸印痕层（表现层，整场战斗一个中央层）
 * ============================================================
 *
 * 设计文档：`docs/打击反馈设计.md` §4（四类印痕的画法）/ §5（预算与合并）/ §6（落点）。
 * 数值真源：`HitFeelConfig.ts` 的 `HIT_FEEL_TIERS[].mark`（画几条）+ `HIT_FEEL_MARK`（怎么画）。
 *
 * ---- 一句话：命中时在图纸上"盖一个印痕" ----
 * 本作的战场底是 `#EBF4FB`（浅底图纸风），发光/白闪/粒子在后处理与美术禁用清单里都走不通，
 * 所以命中反馈只剩三样：**时间**（顿帧，见 `HitFeelDirector`）、**位移**（抖动/内容层位移，见
 * `EntityView`/`Scene_Game_Stage`）、**线条**（本层）。风格预设把"实线 = 已存在的实体、
 * 虚线/淡线 = 预告"写成基本语法，本层就是这条语法的两句话：
 *   · **印痕**（实线）= 已经打中了：刻度 / 细环 / 对位十字 /（死亡时）碎片；
 *   · **起手印痕**（虚线）= 正在打出去：一条朝目标的短虚线，**不延后任何结算**（口径 6）。
 *
 * ---- 为什么"整层一个 Graphics"（照抄 DamageTextLayer）----
 *   · Label / Sprite 都是"一个组件一次 draw call"，24 个印痕 + 48 块碎片 = 72 次；
 *     画在同一个 Graphics 上则整层恒定 **1 次**，而且池化的是**纯数据对象**（连节点都不用建）。
 *   · 全部是纯色几何（无贴图、无材质切换）→ 顶点合批不会被打断。
 *
 * ---- 坐标：零转换（与 DamageTextLayer 同一条契约）----
 *   `EntityView.bind` 是直接 `node.setPosition(entity.position)`，即 **monsterParent 的局部空间
 *   == 逻辑世界坐标**；本层节点与 `enimys` 在预制件里同为根下兄弟、局部变换都是 (0,0)/1，
 *   两个局部空间完全重合 → `entity.position` **拿来即用，不做任何坐标转换**。
 *   契约（改层级时必须遵守）：层节点必须与 monsterParent 同坐标系；bind 时做一次自检（checkSpace）。
 *
 * ---- 位置必须"回调里立刻快照"（与 DamageTextLayer 同一条硬约束）----
 *   `DamagePipeline` 在 ChangeHp **之后**、Die **之前**发布 `OnTakeDamage`，而实体死亡后
 *   `EntityView.update` 就不再同步位置了 —— 所以命中点在事件回调里读一次存下来，之后再读就是过时值。
 *
 * ---- 时间：印痕走**真实时间**，不吃顿帧 ----
 *   顿帧/慢动作缩的是**战斗时钟**（`ctx.Tick`），而印痕是"盖完就没了"的一次性图形：
 *   若让它跟着慢放，T7 通关那 90ms 顿帧里印痕几乎不动 —— 那就白画了（碎片也一样，
 *   它们在图上一动不动反而像卡住了）。所以本层用 `clampBattleDt(dt)` 的**真实帧增量**推进。
 *
 * ---- 预算（塔防刚需：后期 3 次/秒 × 6 只/批 → 必须有上限）----
 *   · 每秒新建 ≤ `HIT_FEEL_BUDGET.markSpawnPerSecMax`（超限**丢弃并计数**，不排队不补偿）；
 *   · 同时在场 ≤ `markAliveMax`（超限先淘汰**最弱档里最老的**）；
 *   · 碎片 ≤ `shardAliveMax`（超限淘汰最老的）；
 *   · 强度整体乘密度自适应系数 `k`（出生时快照，见下）。
 *
 * ---- 合并（G2）：档位相同 + 颜色相同 + 40ms 内 + 80px 内 → 合成一次 ----
 *   AoE 打一片 20 只时，20 个同心环只会糊成一团；合并后落在**质心**、读作"这一片被盖了一章"。
 *   注意**不同档位不合并**（暴击与普攻的印痕形状不同，合起来会同时说谎）。
 *   ⚠ 合并只把位置挪到质心、**画法一字不变**（`count` 只用于加权），所以"炸 6 只"与"打 1 只"
 *   在 B5 之前是**逐图元相同**的 —— 那正是 B5 形态层要解决的问题。
 *
 * ---- 第二根轴：技能形态（B5）----
 *   档位回答"多重"，形态回答"**是什么**"（链式 / 爆炸 / 多段 / 全场）。判据是"同源 + 同帧 +
 *   一次普攻或击杀锚点"的落点几何，实现是 `HitFeelConfig.resolveHitShape`（纯函数，两份缓冲各算一次）。
 *   · 有形态的那一批 → 画**一个**形态图形，这一批的个体印痕**全部不发**（形态吸收，总量反而下降）；
 *   · 没有形态 → 与 B2 行为完全一致。
 *   形态图形的额度、上限、统计都**与印痕分开**（见 `shapes` 字段的注释）。
 *
 * ---- 密度自适应（k 出生时快照）----
 *   `k` 在**出生那一刻**取一次并存在数据对象上，之后不再变 —— 否则同一批印痕会在"死得越来越多"
 *   的过程中一边扩散一边缩水，读起来像抽搐。`k` 只压**幅度类**（尺寸/线宽/环半径/碎片数），
 *   线宽另有下限 `HIT_FEEL_MARK.minLineWidth`（压到 0.55px 就等于没画）。
 *
 * 用法（Scene_Game_Stage）：
 *   三级取用见 `ensureHitVfxLayer()`：① 预制件里已摆好 `vfx` 节点 ② 子树里已有本组件
 *   ③ 运行时建节点插在 `projectile_cache` 与 `damage_layer` 之间。
 *   三条路都走 `bind(ctx, monsterParent)`；换局/退出走 `unbind()`。
 */
@ccclass('HitVfxLayer')
export class HitVfxLayer extends Component {
    /** 全场共用的一块画布：所有印痕与碎片都画在它上面（1 次 draw call） */
    private g: Graphics | null = null;

    /** 战斗上下文（只用来取总线；解绑时置空） */
    private ctx: BattleContext | null = null;
    /** 事件退订句柄（解绑/销毁必须调用） */
    private unsubs: (() => void)[] = [];

    /** 本层自己的时钟（只被 `update` 推进；不读 `Date.now()`，便于体检脚本用假时钟真跑） */
    private clock = 0;

    /** 印痕（含起手印痕）与碎片（分开两份：前者的淘汰要按档位、后者只按年龄） */
    private items: VfxItem[] = [];
    private shards: ShardItem[] = [];
    /** 数据对象池（池化的是数据，不是节点 —— 整层只有一个 Graphics） */
    private freeItems: VfxItem[] = [];
    private freeShards: ShardItem[] = [];

    /**
     * 技能形态图形（B5：链折线 / 爆炸环 / 多段叠印 / 全屏扫线）。
     *
     * ⚠ **与 `items` 分成两份是有意的**（不是图省事）：
     *   · 形态图形的淘汰只按年龄（它没有"档位"可分层，见 `evictShapeIfFull`），
     *     与印痕的"先淘汰最弱档里最老的"是两套规则；
     *   · 额度也分开（`shapeAliveMax` / `shapeSpawnPerSecMax` vs `markAliveMax` / `markSpawnPerSecMax`）——
     *     形态**替代**个体印痕而不是叠加，共用一份额度会让"技能救不了糊屏"。
     */
    private shapes: ShapeItem[] = [];
    private freeShapes: ShapeItem[] = [];

    /**
     * 本帧尚未提交的命中（**形态推断的输入**）。
     *
     * 为什么要缓冲：一次 chain / AoE 的 N 次结算落在同一帧，而"这是不是一次技能"
     * 只有等这一帧的锚点（`OnAttackLanded` / `OnKill`）与全部落点都到齐才判得出来。
     * 于是事件回调只**记录**，`update` 开头统一 `flushPending()` 提交 ——
     * 代价是印痕晚一帧出现（16ms），与 `HitFeelDirector` 的"上一帧事件、这一帧提交"完全同一条口径。
     */
    private pending: PendingBatch[] = [];

    /**
     * 本帧已经逐段记录了多少条命中（**单帧采样闸门**，见 `onTakeDamage` 与
     * `HIT_FEEL_BUDGET.perFrameHitSampleMax`）。
     *
     * 帧边界与 `pending` 同步：`flushPending()` 提交完就归零。
     */
    private pendingHits = 0;

    /** 印痕新建时间戳（1s 滑动窗口，用来卡每秒新建上限） */
    private spawnTimes: number[] = [];
    /** 形态图形新建时间戳（1s 滑动窗口；**与印痕分开记**，见 `shapes` 的注释） */
    private shapeSpawnTimes: number[] = [];

    /** 供 Graphics.strokeColor / fillColor 复用的 Color 实例（setter 内部做拷贝，可以放心复用） */
    private readonly paint = new Color(255, 255, 255, 255);
    /** 上一帧是否真的画过：空场时省掉每帧 clear() */
    private drewLastFrame = false;

    /**
     * 逻辑坐标的参照节点（= monsterParent）
     *
     * 只用于 bind 时的一次坐标系自检（见 checkSpace）—— 印痕按逻辑坐标直接绘制、不做坐标转换，
     * 前提是本层节点与它同坐标系。
     */
    private spaceAnchor: Node | null = null;

    /** 统计（调试面板 / `npm run audit:hitfeel` 读它；不做任何业务判断） */
    readonly stats: HitVfxStats = {
        marks: 0, attacks: 0, evades: 0, shards: 0, merged: 0,
        spawnDropped: 0, evicted: 0, shardsDropped: 0, alivePeak: 0, redraws: 0, hitsDropped: 0,
        shapes: 0, chains: 0, blasts: 0, multis: 0, fans: 0, reported: 0,
        shapesDropped: 0, shapesEvicted: 0, shapeAlivePeak: 0, shapeSpawnDropped: 0,
    };

    /**
     * 本帧收到的**显式形态上报**（`OnSkillShape`，见 `battle/SkillShape.ts`）。
     *
     * 为什么也要缓冲到帧末：上报与它引起的伤害事件**在同一帧**发出，而"这一批命中要不要
     * 被这个形态吸收"要等两边的清单都齐了才判得出来（同 `pending` 的理由）。
     */
    private pendingShapes: SkillShapeReport[] = [];

    // ============ 绑定 / 解绑 ============

    /**
     * 绑定战斗上下文：取画布 + 订阅三条总线（整层只订阅一次）
     *
     * @param ctx         战斗上下文（只用来取总线）
     * @param spaceAnchor **逻辑坐标的参照节点**（= monsterParent）。只用于坐标系自检
     */
    bind(ctx: BattleContext, spaceAnchor?: Node): void {
        this.unbind();

        this.g = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
        // 圆头 + 圆角拐角（风格预设：线宽 1.2~3px、圆头）—— 单条短线的端头才不会"啃掉"一截
        this.g.lineJoin = Graphics.LineJoin.ROUND;
        this.g.lineCap = Graphics.LineCap.ROUND;

        // UITransform 只影响布局/裁剪框，不影响 Graphics 自己画在哪 ——
        // 但撑满整个战场可以避免"UI 渲染按节点矩形剔除"把远处印痕剔掉；本层节点除了位移永不动它。
        const ui = this.node.getComponent(UITransform);
        if (ui) ui.setContentSize(COVER_SIZE, COVER_SIZE);

        this.spaceAnchor = spaceAnchor ?? this.node.parent;
        this.checkSpace(this.spaceAnchor);

        this.ctx = ctx;
        if (ctx?.bus) {
            this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnTakeDamage, this.onTakeDamage, this));
            this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnDeath, this.onDeath, this));
            this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnAttackStart, this.onAttackStart, this));
            // F3 几何符号：闪避（"没打中"也要有形状，而不是什么都不发生）
            this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnEvade, this.onEvade, this));
            // B5 形态层：**锚点**（没有它就没有"这一批是不是一次技能"的判据，见 HIT_FEEL_SHAPE 的文件头）
            this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnAttackLanded, this.onAttackLanded, this));
            this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnKill, this.onKill, this));
            // 「路 B」：战斗侧**显式上报**的技能形态（爆炸环 / 链折线 / 扇形）。
            // 它优先于几何推断 —— 判据与结算几何同源，且能覆盖"没有锚点、几何猜不出来"的效果
            // （Boss 咆哮、神器天怒、击杀爆炸都是这一类）。
            this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnSkillShape, this.onSkillShape, this));
        }
    }

    /**
     * 坐标系自检（bind 时一次；纯局部变换比较，不依赖世界矩阵，所以不会有"矩阵还没就绪"的误报）
     *
     * 能零成本且**必定正确**地判出来的错法只有一种：层节点就在参照节点的同一父节点下、
     * 但被挪了位置或改了缩放 —— 这时两个局部空间差一个位移/缩放，印痕会整体偏掉。
     * 其余层级关系（挂到别的父节点下）没法廉价校验，见类注释的坐标系契约。
     */
    private checkSpace(anchor: Node | null): void {
        if (!anchor?.isValid || this.node.parent !== anchor) return;
        const p = this.node.position;
        const s = this.node.scale;
        if (p.x === 0 && p.y === 0 && s.x === 1 && s.y === 1) return;
        console.warn(
            `[HitVfxLayer] 印痕层与 ${anchor.name} 同父但局部变换不同`
            + `（position=${p.x},${p.y} scale=${s.x},${s.y}）：印痕按逻辑坐标直接绘制、不做坐标转换，`
            + '位置会整体偏移 —— 请把层节点的 position 归零、scale 置 1，或让它与参照节点保持同一变换。',
        );
    }

    /**
     * 解绑 / 清场：退订 + 回收全部印痕与碎片 + 清画布。
     * 用在**节点还活着**的时候（换局 `resetRun`、退出战斗、重新 bind）。
     * 节点整棵被销毁走 `onDestroy`（那里不清画布，理由见 `DamageTextLayer.onDestroy`）。
     */
    unbind(): void {
        for (let i = 0; i < this.unsubs.length; i++) this.unsubs[i]();
        this.unsubs.length = 0;
        this.ctx = null;
        this.items.length = 0;
        this.shards.length = 0;
        this.shapes.length = 0;
        this.pending.length = 0;
        this.pendingShapes.length = 0;
        this.spawnTimes.length = 0;
        this.shapeSpawnTimes.length = 0;
        this.pendingHits = 0;
        this.clock = 0;
        if (this.g) this.g.clear();
        this.drewLastFrame = false;
    }

    /**
     * 组件销毁兜底：**只退订 + 断引用，不碰画布**。
     *
     * 与 `DamageTextLayer.onDestroy` 同一套理由：画布与本组件同节点，销毁顺序由组件注册顺序决定，
     * `Graphics._impl` 可能已被置 null，此时 `clear()` 会抛 TypeError；而 `onDestroy` 是引擎
     * `CCObject._deferredDestroy()` 调的 —— 那里抛异常会让销毁队列不清空（下一帧从同一个对象重新抛），
     * 并且 `director.tick` 会在绘制/提交渲染之前被打断 → **画面永久卡在上一帧**。
     */
    onDestroy(): void {
        for (let i = 0; i < this.unsubs.length; i++) this.unsubs[i]();
        this.unsubs.length = 0;
        this.ctx = null;
        this.spaceAnchor = null;
        this.items.length = 0;
        this.shards.length = 0;
        this.shapes.length = 0;
        this.pending.length = 0;
        this.pendingShapes.length = 0;
        this.freeItems.length = 0;
        this.freeShards.length = 0;
        this.freeShapes.length = 0;
        this.spawnTimes.length = 0;
        this.shapeSpawnTimes.length = 0;
        this.g = null;
    }

    /** 当前在场的印痕数（含起手印痕；调试 / 自检用） */
    get aliveMarkCount(): number {
        return this.items.length;
    }

    /** 当前在场的碎片数（调试 / 自检用） */
    get aliveShardCount(): number {
        return this.shards.length;
    }

    /** 当前在场的技能形态图形数（调试 / 自检用；**与 `aliveMarkCount` 是两份额度**） */
    get aliveShapeCount(): number {
        return this.shapes.length;
    }

    // ============ 事件入口（总线） ============

    /**
     * 命中：**只记账，不立刻画**（形态推断的输入；真正的提交在下一帧 `update` 的 `flushPending`）。
     *
     * 为什么要攒着：同一帧里"这一下是普攻还是技能"判不出来 —— 技能那 N 次命中会紧跟在本条之后。
     * 攒到帧末，`resolveHitShape` 一次性回答"这 N 下是不是同一次技能、是链还是爆"。
     * ⚠ 位置仍在**回调里立刻快照**（`DamageTextLayer` / `HitVfxLayer` 共用的那条硬约束：
     * `DamagePipeline` 在 `ChangeHp` 之后发事件，实体可能马上被回收，之后再读就是过时值）。
     */
    private onTakeDamage(e: any): void {
        const target = e?.target;
        if (!target?.position) return;
        /**
         * ⚠ **单帧只逐段记前 `perFrameHitSampleMax` 段**（超出的只累加计数，见 stats.hitsDropped）。
         *
         * 为什么：本方法是**每段一个对象**的分配点，而段数一爆（实测 boss 战一帧 4~6.8 万段）
         * 就是"一帧几万个临时对象 → major GC 停顿几百 ms~数秒"。
         * 而采样只喂**形态推断**（落点几何），前 512 个落点足够定形状，
         * 印痕本身另有 `markAliveMax` 淘汰 ⇒ 超出的部分**画面本来也画不出来**。
         */
        if (this.pendingHits >= HIT_FEEL_BUDGET.perFrameHitSampleMax) {
            this.stats.hitsDropped++;
            return;
        }
        this.pendingHits++;
        const srcUid = e?.source?.uid ?? -1;
        const batch = this.batchOf(srcUid);
        const dir = directionOf(e?.source, target);
        batch.hits.push({
            uid: target.uid ?? 0,
            x: target.position.x,
            y: target.position.y,
            tier: resolveHitTier(e),
            dirX: dir.x,
            dirY: dir.y,
            heroHurt: target.unitKind === UnitKind.Hero,
        });
    }

    /**
     * 普攻命中（**形态层的锚点之一**）：一次普攻的目标就是"这一批技能"的圆心 / 链首。
     *
     * 为什么锚点必须存在：它是"这一批命中是不是一次技能"的唯一判据。
     * 少了它，两只怪身上的 DoT 恰好同帧跳字（同源、同帧、多目标）会被误判成链式弹射。
     */
    private onAttackLanded(e: any): void {
        const srcUid = e?.attacker?.uid ?? -1;
        const tgt = e?.target;
        if (!tgt?.position) return;
        const batch = this.batchOf(srcUid);
        batch.anchorUid = tgt.uid ?? 0;
        batch.anchorX = tgt.position.x;
        batch.anchorY = tgt.position.y;
    }

    /**
     * 击杀（**形态层的锚点之二**）：天怒的"全屏爆炸"、遗物的"击杀爆炸/击杀回响"
     * 都不是普攻引发的，它们的锚点是**死者的位置快照**。
     *
     * ⚠ 只读 `deathPos`，不读 `victim.position` —— 后者在 `OnDeath` 的监听里已被回收清零
     * （`DamagePipeline` 的注释与 `Scene_Game_Stage` 的掉落点都踩过这个坑）。
     */
    private onKill(e: any): void {
        const srcUid = e?.killer?.uid ?? -1;
        const pos = e?.deathPos ?? e?.victim?.position;
        const batch = this.batchOf(srcUid);
        batch.hasKill = true;
        if (batch.anchorUid === 0 && pos) {
            batch.anchorUid = e?.victim?.uid ?? -1;         // -1 = "有锚点但没有锚点自身的命中"
            batch.anchorX = pos.x ?? 0;
            batch.anchorY = pos.y ?? 0;
        }
    }

    /**
     * **显式形态上报**（路 B）：战斗侧说"我刚放了一个半径 X 的圆 / 一张半角 Y 的扇"。
     *
     * 只**记录**、不立刻画（与命中同一条口径：帧末统一 `flushPending`），
     * 因为"这一批命中要不要被这个形态吸收"要等两边都齐了才判得出来。
     *
     * ⚠ 位置在回调里**立刻快照**：上报发生在效果结算的同一帧，而实体随时可能被回收
     *   （`OnDeath` 的监听里就 `recycleMonster` 了），之后再去读 `source.position` 就是 (0,0)。
     */
    private onSkillShape(e: any): void {
        if (!e || !Number.isFinite(e.cx) || !Number.isFinite(e.cy)) return;
        if (!Number.isFinite(e.radius) || e.radius <= 0) return;
        /**
         * **上报方自己画这一发**（`SkillShapeReport.noDraw`，目前只有地雷）→ 本层整条不接。
         *
         * 为什么是"不接"而不是"接了但不画"：形态层的额度是**按图形个数**算的
         * （`HIT_FEEL_BUDGET.shapeAliveMax` = 8），一次「引爆器」能同时响 5 颗雷 ——
         * 5 个画不出来的图形占着 5/8 的额度、还参与淘汰，会把真正要画的爆炸/扇形挤掉。
         * 音效与顿帧**不受影响**：那次上报在总线上照发，导演（`HitFeelDirector`）自己订阅了它。
         */
        if (e.noDraw === true) return;
        if (this.pendingShapes.length >= HIT_FEEL_BUDGET.shapeAliveMax * 2) return;   // 上界兜底，别被脏数据撑爆
        this.pendingShapes.push({
            shape: e.shape,
            cx: e.cx,
            cy: e.cy,
            radius: e.radius,
            dirX: Number(e.dirX) || 0,
            dirY: Number(e.dirY) || 0,
            halfAngleDeg: Number(e.halfAngleDeg) || 0,
            points: e.points ?? [],
            source: e.source,
            target: e.target,
        });
    }

    /** 死亡：收尾印痕（普通怪 T2 / 精英·Boss T5 / 最终 Boss T7）—— 碎片只在死亡时出现 */
    private onDeath(e: any): void {
        const entity = e?.entity;
        if (!entity?.position) return;
        const tier = resolveDeathTier(entity);
        if (tier === HitFeelTier.None) return;                 // 英雄阵亡：交给结算面板，表现不插手
        const dir = directionOf(e?.killer, entity);
        this.spawnMark(entity.position.x, entity.position.y, tier, dir.x, dir.y, false);
    }

    /**
     * 出手：画一条朝目标的**短虚线**（= 风格预设里的"预告线"）。
     *
     * 这是「前摇」的替代品：不延后结算（口径 6），只给"我打了它"与"它掉血"之间补一个**因**。
     * 颜色用次级墨灰而不是英雄红 —— 颜色通道只回答"打谁"（口径 4），而出手者的身份由位置回答。
     */
    private onAttackStart(e: any): void {
        const attacker = e?.attacker;
        const target = e?.target;
        if (!attacker?.position || !target?.position) return;
        const dx = target.position.x - attacker.position.x;
        const dy = target.position.y - attacker.position.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (!(len > 0)) return;                                // 完全重合 → 没有方向可言，不画

        if (!this.consumeSpawnQuota()) {
            this.stats.spawnDropped++;
            return;
        }
        const it = this.obtainItem();
        const inv = 1 / len;
        it.kind = VfxKind.Attack;
        it.tier = HitFeelTier.None;
        it.dirX = dx * inv;
        it.dirY = dy * inv;
        // 起笔点在本体外缘之外（collisionRadius 已含体型缩放，Boss 的线不会从它肚子里出来）
        const offset = radiusOf(attacker) + HIT_FEEL_MARK.attackOffset;
        it.x = attacker.position.x + it.dirX * offset;
        it.y = attacker.position.y + it.dirY * offset;
        it.age = 0;
        it.life = HIT_FEEL_MARK.attackLifeMs / 1000;
        it.k = this.density();
        it.heroHurt = false;
        it.count = 1;
        this.items.push(it);
        this.stats.attacks++;
        if (this.items.length > this.stats.alivePeak) this.stats.alivePeak = this.items.length;
    }

    /**
     * 闪避（F3 几何符号）：在被闪避者**头顶上方**画一道斜杠。
     *
     * 为什么要有它：本作里"闪避"原先**完全静默**（`Entity.resolveAttackHit` 里直接 return），
     * 于是"我有 45% 闪避"这条属性在屏幕上没有任何存在感 —— 玩家只看到伤害数字消失。
     * 斜杠（而不是圆/方）是"落空"的通用符号，且与印痕的"实线 = 已发生的实体"语法区分得开。
     *
     * 口径：颜色用次级墨灰（比印痕淡一档）—— 闪避是**缺席**，不该和"打中了"抢眼。
     */
    private onEvade(e: any): void {
        const dodger = e?.dodger ?? e?.target;
        if (!dodger?.position) return;
        if (!this.consumeSpawnQuota()) {
            this.stats.spawnDropped++;
            return;
        }
        this.evictIfFull();
        const it = this.obtainItem();
        it.kind = VfxKind.Evade;
        it.tier = HitFeelTier.None;
        it.dirX = 0;
        it.dirY = 1;
        it.x = dodger.position.x;
        it.y = dodger.position.y + HIT_FEEL_MARK.evadeOffsetY + radiusOf(dodger);
        it.age = 0;
        it.life = HIT_FEEL_MARK.evadeLifeMs / 1000;
        it.k = this.density();
        it.heroHurt = false;
        it.count = 1;
        this.items.push(it);
        this.stats.evades++;
        if (this.items.length > this.stats.alivePeak) this.stats.alivePeak = this.items.length;
    }

    // ============ 生成 / 合并 / 淘汰 ============

    /**
     * 盖一个印痕（命中与死亡走同一条路：几何形状由档位表的 `mark` 给出）
     *
     * 顺序是**有意的**：每秒新建上限（最外层的硬闸）→ 合并 → 并发上限。
     * 合并放在并发上限之前，是因为"20 连击合成 1 个"本身就是最有效的减量手段 ——
     * 先淘汰再合并会把刚腾出的位置又占回去。
     */
    private spawnMark(x: number, y: number, tier: HitFeelTier, dirX: number, dirY: number, heroHurt: boolean): void {
        const spec = getTierSpec(tier).mark;
        if (!hasMarkShape(spec)) return;

        if (!this.consumeSpawnQuota()) {
            this.stats.spawnDropped++;
            return;
        }
        if (this.mergeInto(x, y, tier, heroHurt)) {
            this.stats.merged++;
            this.spawnShards(x, y, spec.shards, dirX, dirY, heroHurt);
            return;
        }
        this.evictIfFull();

        const it = this.obtainItem();
        it.kind = VfxKind.Mark;
        it.tier = tier;
        it.dirX = dirX;
        it.dirY = dirY;
        it.x = x;
        it.y = y;
        it.age = 0;
        it.life = markLifeSec(spec);
        it.k = this.density();                                 // 出生快照（见类注释）
        it.heroHurt = heroHurt;
        it.count = 1;
        this.items.push(it);

        this.stats.marks++;
        if (this.items.length > this.stats.alivePeak) this.stats.alivePeak = this.items.length;
        this.spawnShards(x, y, spec.shards, dirX, dirY, heroHurt);
    }

    /**
     * 尝试合并进已有印痕（G2：「档位相同且目标相邻 → 合并为一次」）
     *
     * 合并后位置取**质心**（按合并次数加权）—— 一片 AoE 的印痕落在"这片怪的中心"，
     * 而不是第一只被打的怪身上；`age` 归零续期，整片一起淡出（不会"后来的还没看清就没了"）。
     *
     * @returns 是否已合并（false = 需要新建）
     */
    private mergeInto(x: number, y: number, tier: HitFeelTier, heroHurt: boolean): boolean {
        const r2 = HIT_FEEL_MARK.mergeRadius * HIT_FEEL_MARK.mergeRadius;
        for (let i = 0; i < this.items.length; i++) {
            const it = this.items[i];
            if (it.kind !== VfxKind.Mark) continue;             // 起手印痕不参与（形状不同）
            if (it.tier !== tier || it.heroHurt !== heroHurt) continue;
            if (it.age > HIT_FEEL_MARK.mergeWindowSec) continue; // 已经"盖完"的印痕不再吸收新的
            const dx = x - it.x;
            const dy = y - it.y;
            if (dx * dx + dy * dy > r2) continue;
            const n = it.count + 1;
            it.x += (x - it.x) / n;
            it.y += (y - it.y) / n;
            it.count = n;
            it.age = 0;
            return true;
        }
        return false;
    }

    /** 并发上限：超了就淘汰"最弱档里最老"的那个（档位相同再比年龄） */
    private evictIfFull(): void {
        while (this.items.length >= HIT_FEEL_BUDGET.markAliveMax) {
            let worstIdx = -1;
            let worstScore = Infinity;
            for (let i = 0; i < this.items.length; i++) {
                const it = this.items[i];
                // 起手印痕没有档位 → 按"比最弱档还弱"处理（它是预告，命中的印痕更要紧）
                const rank = it.kind === VfxKind.Mark ? HIT_FEEL_TIER_RANK[it.tier] : -2;
                // 档位权重远大于年龄：先比档位，再比谁更老
                const score = rank * 1000 + it.age;
                if (score < worstScore) {
                    worstScore = score;
                    worstIdx = i;
                }
            }
            if (worstIdx < 0) return;
            this.recycleItem(this.items[worstIdx]);
            this.items.splice(worstIdx, 1);
            this.stats.evicted++;
        }
    }

    /**
     * 出碎片（**只在死亡档位**，`spec.shards > 0`；命中时禁粒子，见设计文档 §9 不做清单）
     *
     * 朝向沿伤害方向 ±25° 散开、初速 60~140px/s、**无重力**（俯视），末段减速滑停。
     * 位置用**闭式解**算（`d = v0 × (t − decay·t²/2) × life`）而不是逐帧积分：
     * 逐帧积分会让同一发碎片的落点随帧率变，闭式解与帧率无关、也天然不会有累积误差。
     */
    private spawnShards(x: number, y: number, count: number, dirX: number, dirY: number, heroHurt: boolean): void {
        if (!(count > 0)) return;
        const k = this.density();
        // 碎片数也吃 k，但**至少 1 块** —— "打死了"必须有残骸，这是因果不是装饰
        const n = Math.max(1, Math.round(count * k));
        const base = Math.atan2(dirY, dirX);
        for (let i = 0; i < n; i++) {
            // 用稳定伪随机（不用 Math.random）：同一发重复出现时散开方式一致，体检脚本也能真跑
            const h1 = hash01(i * 0x9e3779b1);
            const h2 = hash01(i * 0x85ebca6b + 7);
            const u = n <= 1 ? 0.5 : i / (n - 1);
            const a = base + (u * 2 - 1) * HIT_FEEL_MARK.shardSpreadRad;
            const speed = HIT_FEEL_MARK.shardSpeedMin
                + (HIT_FEEL_MARK.shardSpeedMax - HIT_FEEL_MARK.shardSpeedMin) * h1;
            this.evictShardIfFull();
            const s = this.freeShards.pop() ?? ({} as ShardItem);
            s.x0 = x + Math.cos(a) * HIT_FEEL_MARK.shardBirthRadius;
            s.y0 = y + Math.sin(a) * HIT_FEEL_MARK.shardBirthRadius;
            s.vx = Math.cos(a) * speed;
            s.vy = Math.sin(a) * speed;
            s.size = Math.max(
                HIT_FEEL_MARK.shardSizeFloor,
                (HIT_FEEL_MARK.shardSizeMin + (HIT_FEEL_MARK.shardSizeMax - HIT_FEEL_MARK.shardSizeMin) * h2) * k,
            );
            // 两档墨色交替：一整排同色实心方块会读成"UI 小方块"，交错一档才有纸面排线的味道
            s.color = heroHurt ? HIT_FEEL_MARK.heroRed : (i % 3 === 2 ? HIT_FEEL_MARK.inkSoft : HIT_FEEL_MARK.ink);
            s.age = 0;
            s.life = HIT_FEEL_MARK.shardLifeMs / 1000;
            this.shards.push(s);
            this.stats.shards++;
        }
    }

    /** 碎片并发上限：超了淘汰最老的（碎片没有档位可分） */
    private evictShardIfFull(): void {
        while (this.shards.length >= HIT_FEEL_BUDGET.shardAliveMax) {
            let worstIdx = -1;
            let worstAge = -1;
            for (let i = 0; i < this.shards.length; i++) {
                if (this.shards[i].age > worstAge) {
                    worstAge = this.shards[i].age;
                    worstIdx = i;
                }
            }
            if (worstIdx < 0) return;
            this.recycleShard(this.shards[worstIdx]);
            this.shards.splice(worstIdx, 1);
            this.stats.shardsDropped++;
        }
    }

    /**
     * 每秒新建上限（1s 滑动窗口）
     *
     * 印痕与起手印痕**共用**这个额度（两者都是"印痕"，见设计文档 §5.3）——
     * 后期 3 次/秒 × 6 只怪 + 6 条起手虚线，必须先卡总量再谈形状。
     */
    private consumeSpawnQuota(): boolean {
        if (this.spawnTimes.length >= HIT_FEEL_BUDGET.markSpawnPerSecMax) return false;
        this.spawnTimes.push(this.clock);
        return true;
    }

    /** 裁剪新建速率窗口（只保留最近 `markSpawnWindowSec` 内的时间戳） */
    private pruneSpawnTimes(): void {
        const from = this.clock - HIT_FEEL_BUDGET.markSpawnWindowSec;
        let drop = 0;
        while (drop < this.spawnTimes.length && this.spawnTimes[drop] < from) drop++;
        if (drop > 0) this.spawnTimes.splice(0, drop);
    }

    /** 当前密度衰减系数 k（读全局导演；没有导演时 = 1，即"全额表现"） */
    private density(): number {
        return HitFeelDirector.active?.densityScale ?? 1;
    }

    /** 取一个印痕数据对象（对象池复用） */
    private obtainItem(): VfxItem {
        return this.freeItems.pop() ?? ({} as VfxItem);
    }

    /** 回收一个印痕数据对象 */
    private recycleItem(it: VfxItem): void {
        if (this.freeItems.length < HIT_FEEL_BUDGET.markAliveMax * 2) this.freeItems.push(it);
    }

    /** 回收一块碎片数据对象 */
    private recycleShard(s: ShardItem): void {
        if (this.freeShards.length < HIT_FEEL_BUDGET.shardAliveMax * 2) this.freeShards.push(s);
    }

    // ============ 每帧：提交缓冲 → 推进 → 整层重绘 ============

    update(dt: number): void {
        const g = this.g;
        if (!g) return;

        // dt 先过掉帧守卫（掉帧不该让印痕"跳"一大步；见 HIT_FEEL_BUDGET.dtMinSec 的注释）
        const d = clampBattleDt(dt);
        this.clock += d;
        this.pruneSpawnTimes();
        this.pruneShapeSpawnTimes();

        // 0) 提交上一帧攒下的命中（形态判定 + 画印痕；**必须在推进寿命之前** ——
        //    否则刚建出来的印痕会被自己这一帧的 dt 先老掉一次）
        this.flushPending();

        // 1) 推进寿命、回收到期（倒序遍历，边删边退）
        for (let i = this.items.length - 1; i >= 0; i--) {
            const it = this.items[i];
            it.age += d;
            if (it.age >= it.life) {
                this.recycleItem(it);
                this.items.splice(i, 1);
            }
        }
        for (let i = this.shards.length - 1; i >= 0; i--) {
            const s = this.shards[i];
            s.age += d;
            if (s.age >= s.life) {
                this.recycleShard(s);
                this.shards.splice(i, 1);
            }
        }
        for (let i = this.shapes.length - 1; i >= 0; i--) {
            const s = this.shapes[i];
            s.age += d;
            if (s.age >= s.life) {
                this.recycleShape(s);
                this.shapes.splice(i, 1);
            }
        }

        // 2) 空场且上帧也没画过 → 省掉 clear()
        if (this.items.length === 0 && this.shards.length === 0 && this.shapes.length === 0 && !this.drewLastFrame) return;

        // 3) 整层重绘（clear 一次 + 全部图元，全程 1 次 draw call）
        g.clear();
        // 碎片在最下（残骸），印痕压在上面；印痕内按出生顺序画 → 最新那一下永远在最上层
        for (let i = 0; i < this.shards.length; i++) this.drawShard(g, this.shards[i]);
        for (let i = 0; i < this.items.length; i++) {
            if (this.items[i].kind === VfxKind.Attack) this.drawAttack(g, this.items[i]);
        }
        for (let i = 0; i < this.items.length; i++) {
            if (this.items[i].kind === VfxKind.Evade) this.drawEvade(g, this.items[i]);
        }
        // 形态图形画在个体印痕**之下**：它是"这一片发生了什么"的背景说明，
        // 压在上面会把"打谁"（每个受击者身上那一下）盖掉 —— 口径 4 把颜色/个体信息留给印痕。
        for (let i = 0; i < this.shapes.length; i++) this.drawShape(g, this.shapes[i]);
        for (let i = 0; i < this.items.length; i++) {
            if (this.items[i].kind === VfxKind.Mark) this.drawMark(g, this.items[i]);
        }
        this.drewLastFrame = this.items.length > 0 || this.shards.length > 0 || this.shapes.length > 0;
        this.stats.redraws++;
    }

    // ============ 缓冲提交（B5 形态层） ============

    /** 取本帧某个来源的命中批次（没有就建一个）；同一来源的事件天然聚成一批 */
    private batchOf(srcUid: number): PendingBatch {
        for (let i = 0; i < this.pending.length; i++) {
            if (this.pending[i].srcUid === srcUid) return this.pending[i];
        }
        const b: PendingBatch = {
            srcUid, hits: [], anchorUid: 0, anchorX: 0, anchorY: 0, hasKill: false,
        };
        this.pending.push(b);
        return b;
    }

    /**
     * 提交本帧攒下的全部命中。
     *
     * 每一批走同一条路，**优先信"显式上报"、其次才是"几何推断"**：
     *   ① 本帧有同源的上报形态（`OnSkillShape`）→ 画它，这一批的个体印痕被吸收；
     *   ② 否则问形态层（`resolveHitShape`）—— 回答了形状就画，这一批的个体印痕被吸收；
     *   ③ 回答 null（普攻 / DoT / 光环 / 互不相干的多目标）→ 逐个发个体印痕，与 B2 完全一致。
     *
     * ⚠ **形态被预算丢掉时必须退回个体印痕**：否则"技能打中一片怪"会变成屏幕上什么都不发生
     * （比画错形状严重得多 —— 那正是本层要修的那个 bug）。所以 ①② 失败都会落到 ③。
     * ⚠ **没有配对到批次的上报也要画**：Boss 的咆哮可能一个敌人都没打中（纯 debuff / 目标已死），
     *   而"放了一个扇形技能"这件事本身就该有表现。
     */
    private flushPending(): void {
        const batches = this.pending;
        const reports = this.pendingShapes;
        this.pending = [];
        this.pendingShapes = [];
        // 单帧采样闸门与新的一帧同时重置（放在这里而不是 `update` 末尾：本方法是唯一提交点）
        this.pendingHits = 0;
        if (batches.length === 0 && reports.length === 0) return;

        const claimed: boolean[] = reports.map(() => false);

        for (let i = 0; i < batches.length; i++) {
            const b = batches[i];
            if (b.hits.length === 0) continue;

            let handled = false;
            // ① 显式上报（同源）：一个来源一帧内的多个上报里只认第一个与它配对的
            const ri = this.matchReport(b, reports, claimed);
            if (ri >= 0) {
                claimed[ri] = true;
                if (this.spawnShape(this.reportToShape(reports[ri]), b, true)) handled = true;
                else this.stats.shapesDropped++;
            }
            // ② 几何推断
            if (!handled) {
                const shape = resolveHitShape({
                    hits: b.hits, anchorUid: b.anchorUid, anchorX: b.anchorX, anchorY: b.anchorY, hasKill: b.hasKill,
                });
                if (shape) {
                    if (this.spawnShape(shape, b, false)) handled = true;
                    // 形态没画成（额度满）→ 退回个体印痕，并**记账**：
                    // "技能打中一片怪却什么都不发生"是本层要修的那个 bug，不许悄悄复发
                    else this.stats.shapesDropped++;
                }
            }
            if (handled) continue;

            for (let k = 0; k < b.hits.length; k++) {
                const h = b.hits[k];
                this.spawnMark(h.x, h.y, h.tier, h.dirX, h.dirY, h.heroHurt);
            }
        }

        // ③ 没被任何批次领走的上报（纯 debuff 的扇形、目标已死的范围技能…）
        for (let i = 0; i < reports.length; i++) {
            if (claimed[i]) continue;
            this.spawnShape(this.reportToShape(reports[i]), null, true);
        }
    }

    /**
     * 给一批命中找它的显式上报（判据 = **来源实体 uid 相同**，且还没被别人领走）。
     *
     * 为什么只认 uid 就够：上报与伤害是**同一次效果结算里前后脚**发出的，同一帧里
     * 一个来源一般只有一个范围效果；而 boss/英雄的多个效果各自有自己的上报，
     * 用"领取制"（claimed）保证一条上报只吸收一批。
     */
    private matchReport(batch: PendingBatch, reports: SkillShapeReport[], claimed: boolean[]): number {
        for (let i = 0; i < reports.length; i++) {
            if (claimed[i]) continue;
            const srcUid = reports[i]?.source?.uid ?? -1;
            if (srcUid === batch.srcUid) return i;
        }
        return -1;
    }

    /** 上报 → 形态结果（少一层转换：两者字段本来就对齐，只有 Fan 多两个朝向字段） */
    private reportToShape(rep: SkillShapeReport): HitShapeResult {
        return {
            kind: rep.shape,
            points: rep.points ?? [],
            cx: rep.cx,
            cy: rep.cy,
            radius: rep.radius,
            stacks: 0,
            dirX: rep.dirX ?? 0,
            dirY: rep.dirY ?? 0,
            halfAngleDeg: rep.halfAngleDeg ?? 0,
        };
    }

    // ============ 形态图形：生成 / 淘汰 / 额度 ============

    /**
     * 生成一个形态图形。
     *
     * @param batch 触发它的那一批命中（**可空**：没配对到批次的上报也要画，见 `flushPending` ③）
     * @param reported 是否来自战斗侧的显式上报（只用于记账 `stats.reported`）
     * @returns 是否成功（false = 被额度丢弃 → 调用方必须退回个体印痕）
     */
    private spawnShape(shape: HitShapeResult, batch: PendingBatch | null, reported: boolean): boolean {
        const spec = getShapeSpec(shape.kind);
        if (!(spec.lifeMs > 0)) return false;
        if (!this.consumeShapeQuota()) {
            this.stats.shapeSpawnDropped++;
            return false;
        }
        this.evictShapeIfFull();

        const it = this.freeShapes.pop() ?? ({} as ShapeItem);
        it.kind = shape.kind;
        it.cx = shape.cx;
        it.cy = shape.cy;
        it.radius = shape.radius;
        it.stacks = Math.max(1, Math.min(shape.stacks, HIT_FEEL_SHAPE.multiMaxStacks));
        // 落点：折线要全部（画线靠它们）；**包围盒必须用完整点集算**，不能等截断之后再算 ——
        // 多落点的批次（如一片怪同时被 AoE 打中）截断后的包围盒会缩水
        it.pts = [];
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < shape.points.length; i++) {
            const px = shape.points[i].x;
            const py = shape.points[i].y;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
            if (it.pts.length < SHAPE_POINT_MAX * 2) it.pts.push(px, py);
        }
        it.bbMinX = minX;
        it.bbMaxX = maxX;
        it.bbMinY = minY;
        it.bbMaxY = maxY;
        // 朝向：**扇形用上报给的**（几何推不出朝向）；其余形状沿用伤害方向
        // （Multi 靠它决定叠印的偏移轴；缺省时兜底 (1,0)，画出来是一条水平的叠印，不会消失）
        const first = batch?.hits?.[0] ?? null;
        if (shape.kind === HitShapeKind.Fan) {
            const len = Math.hypot(shape.dirX ?? 0, shape.dirY ?? 0);
            it.dirX = len > 1e-6 ? (shape.dirX as number) / len : 1;
            it.dirY = len > 1e-6 ? (shape.dirY as number) / len : 0;
        } else {
            it.dirX = first?.dirX ?? shape.dirX ?? 0;
            it.dirY = first?.dirY ?? shape.dirY ?? 0;
        }
        it.halfAngleDeg = shape.kind === HitShapeKind.Fan
            ? clampFanHalfAngle(shape.halfAngleDeg ?? 0)
            : 0;
        it.k = this.density();
        it.heroHurt = first?.heroHurt ?? false;
        it.age = 0;
        it.life = spec.lifeMs / 1000;
        this.shapes.push(it);

        this.stats.shapes++;
        if (reported) this.stats.reported++;
        if (shape.kind === HitShapeKind.Chain) this.stats.chains++;
        else if (shape.kind === HitShapeKind.Blast) this.stats.blasts++;
        else if (shape.kind === HitShapeKind.Multi) this.stats.multis++;
        else if (shape.kind === HitShapeKind.Fan) this.stats.fans++;
        if (this.shapes.length > this.stats.shapeAlivePeak) this.stats.shapeAlivePeak = this.shapes.length;
        return true;
    }

    /** 形态图形并发上限：超了淘汰**最老的**（形态没有档位可分层，与碎片同一条规则） */
    private evictShapeIfFull(): void {
        while (this.shapes.length >= HIT_FEEL_BUDGET.shapeAliveMax) {
            let worstIdx = -1;
            let worstAge = -1;
            for (let i = 0; i < this.shapes.length; i++) {
                if (this.shapes[i].age > worstAge) {
                    worstAge = this.shapes[i].age;
                    worstIdx = i;
                }
            }
            if (worstIdx < 0) return;
            this.recycleShape(this.shapes[worstIdx]);
            this.shapes.splice(worstIdx, 1);
            this.stats.shapesEvicted++;
        }
    }

    /**
     * 形态图形的每秒新建上限（1s 滑动窗口）。
     *
     * **与印痕的额度分开**（理由见 `shapes` 的注释）：形态替代个体印痕，两者不该抢同一份额度。
     */
    private consumeShapeQuota(): boolean {
        if (this.shapeSpawnTimes.length >= HIT_FEEL_BUDGET.shapeSpawnPerSecMax) return false;
        this.shapeSpawnTimes.push(this.clock);
        return true;
    }

    /** 裁剪形态新建速率窗口 */
    private pruneShapeSpawnTimes(): void {
        const from = this.clock - HIT_FEEL_BUDGET.shapeSpawnWindowSec;
        let drop = 0;
        while (drop < this.shapeSpawnTimes.length && this.shapeSpawnTimes[drop] < from) drop++;
        if (drop > 0) this.shapeSpawnTimes.splice(0, drop);
    }

    /** 回收一个形态数据对象 */
    private recycleShape(s: ShapeItem): void {
        if (this.freeShapes.length < HIT_FEEL_BUDGET.shapeAliveMax * 2) this.freeShapes.push(s);
    }

    // ============ 形态图形：画法 ============

    /**
     * 按形态分派画法（四种形状各有各的语法，颜色一律不参与 —— 口径 4）
     *
     * ⚠ 淡出用 `HIT_FEEL_SHAPE.fadePow` 的**"先实后收"指数**而不是线性 `(1-t)`：
     * 形态寿命 200~280ms，线性淡出会让它大半辈子只剩半透明（用户口径「太浅、看不清」的成因之一）。
     * 曲线口径与"为什么不是一档 α"都写在 `HitFeelConfig` 那个常量上，这里只消费它。
     */
    private drawShape(g: Graphics, it: ShapeItem): void {
        const spec = getShapeSpec(it.kind);
        const t = it.age / it.life;
        if (t >= 1) return;
        const rgb = it.heroHurt ? HIT_FEEL_MARK.heroRed : HIT_FEEL_MARK.ink;
        const fade = Math.max(0, 1 - Math.pow(Math.max(0, Math.min(1, t)), HIT_FEEL_SHAPE.fadePow));
        this.setPaint(g, rgb, spec.alpha * fade);
        g.lineWidth = Math.max(HIT_FEEL_MARK.minLineWidth, spec.lineWidth * it.k);
        switch (it.kind) {
            case HitShapeKind.Chain: this.drawChain(g, it); break;
            case HitShapeKind.Blast: this.drawBlast(g, it); break;
            case HitShapeKind.Multi: this.drawMulti(g, it); break;
            case HitShapeKind.Fan: this.drawFan(g, it); break;
            default: break;
        }
    }

    /**
     * 链式弹射：从锚点（链首）沿跳点画**折线**，每个落点一个端头刻度。
     *
     * 三条画法口径：
     *   · **逐段显现**（`chainSegDelayMs`）—— 读作"电一段一段跳过去"，而不是"整条线突然出现"；
     *   · **每段拆折 + 中点垂直偏移**（`chainJagPx`）—— 直线的语言是"弹道"，折线才是"电"；
     *     偏移靠**折点坐标**实现，**不旋转节点**（口径 5：图纸不该歪）；
     *   · 端头刻度是制图里"尺寸线两端"的语法，读作"这一跳接上了"。
     */
    private drawChain(g: Graphics, it: ShapeItem): void {
        const n = it.pts.length / 2;
        if (n <= 0) return;
        const ageMs = it.age * 1000;
        const jag = HIT_FEEL_SHAPE.chainJagPx * it.k;
        let px = it.cx;
        let py = it.cy;
        for (let i = 0; i < n; i++) {
            const qx = it.pts[i * 2];
            const qy = it.pts[i * 2 + 1];
            const delay = i * HIT_FEEL_SHAPE.chainSegDelayMs;
            if (ageMs >= delay) {
                const dx = qx - px;
                const dy = qy - py;
                const len = Math.hypot(dx, dy);
                if (len > 0) {
                    // 垂直于本段的方向（锯齿偏移用它）
                    const nx = -dy / len;
                    const ny = dx / len;
                    const segs = Math.max(1, HIT_FEEL_SHAPE.chainJagSegments);
                    g.moveTo(px, py);
                    for (let k = 1; k <= segs; k++) {
                        const u = k / segs;
                        // 折点在中点偏移最大、两端归零（用 |sin(2πu)| 的形状，确定性、不随机）
                        const off = k === segs ? 0 : Math.sin(Math.PI * u) * (k % 2 === 0 ? jag : -jag);
                        g.lineTo(px + dx * u + nx * off, py + dy * u + ny * off);
                    }
                    g.stroke();
                }
                // 端头刻度（垂直于最后一小段的走向）
                const half = HIT_FEEL_SHAPE.chainEndTickLen * it.k * 0.5;
                if (len > 0) {
                    const ex = -dy / len;
                    const ey = dx / len;
                    g.lineWidth = Math.max(HIT_FEEL_MARK.minLineWidth, HIT_FEEL_SHAPE.chainEndTickWidth * it.k);
                    g.moveTo(qx - ex * half, qy - ey * half);
                    g.lineTo(qx + ex * half, qy + ey * half);
                    g.stroke();
                    g.lineWidth = Math.max(HIT_FEEL_MARK.minLineWidth, getShapeSpec(it.kind).lineWidth * it.k);
                }
            }
            px = qx;
            py = qy;
        }
    }

    /**
     * 爆炸：以锚点为圆心，**扩散到真实作用半径**（这是本层最主要的理由）。
     *
     * 与档位印痕的细环的区别只有一条、但很关键：那边是"从 6px 扩到 26px"（猜的视觉尺度），
     * 这边扩到的是**这一下真的盖住了多大一片**（`kv.radiusM × pxPerMeter`）。
     * 环上等距刻度 = 制图"尺寸标注"的语法，读作"这一圈就是范围"。
     */
    private drawBlast(g: Graphics, it: ShapeItem): void {
        const ageMs = it.age * 1000;
        const to = Math.max(HIT_FEEL_SHAPE.blastMinRadiusPx, it.radius);
        const rings = Math.max(1, HIT_FEEL_SHAPE.blastRings);
        for (let i = 0; i < rings; i++) {
            const ti = (ageMs - i * HIT_FEEL_SHAPE.blastRingStaggerMs) / (it.life * 1000 / rings + HIT_FEEL_SHAPE.blastRingStaggerMs);
            const t = Math.max(0, Math.min(1, ti));
            if (ti < 0 || ti >= 1) continue;
            const ratio = rings <= 1 ? 1 : 0.7 + 0.3 * (i / (rings - 1));
            // 起步快、末段收（与档位印痕同一条缓动口径）
            const r = Math.max(2, to * ratio * Math.pow(t, HIT_FEEL_SHAPE.blastGrowPow));
            g.circle(it.cx, it.cy, r);                      // 只描边不填充（风格预设的既有口径）
            g.stroke();
        }
        // 径向刻度：只在最外圈接近到位时画（否则刻度会飘在半径之外，读成"打歪了"）
        const ticks = HIT_FEEL_SHAPE.blastRadialTicks;
        const done = ageMs / (it.life * 1000) ;
        if (ticks > 0 && done > 0.35) {
            const half = HIT_FEEL_SHAPE.blastTickLen * it.k * 0.5;
            g.lineWidth = Math.max(HIT_FEEL_MARK.minLineWidth, HIT_FEEL_SHAPE.blastTickWidth * it.k);
            for (let i = 0; i < ticks; i++) {
                const a = (i / ticks) * Math.PI * 2;
                const ca = Math.cos(a);
                const sa = Math.sin(a);
                g.moveTo(it.cx + ca * (to - half), it.cy + sa * (to - half));
                g.lineTo(it.cx + ca * (to + half), it.cy + sa * (to + half));
            }
            g.stroke();
        }
    }

    /** 多段：沿伤害方向逐段叠印（读作"一节一节打出去"），每段一道短横 */
    private drawMulti(g: Graphics, it: ShapeItem): void {
        const ageMs = it.age * 1000;
        const n = Math.max(1, it.stacks);
        const px = -it.dirY;
        const py = it.dirX;
        const len = HIT_FEEL_SHAPE.blastTickLen * it.k;
        for (let i = 0; i < n; i++) {
            if (ageMs < i * HIT_FEEL_SHAPE.multiStaggerMs) continue;
            const off = i * HIT_FEEL_SHAPE.multiDriftPx * it.k;
            const cx = it.cx + it.dirX * off;
            const cy = it.cy + it.dirY * off;
            g.moveTo(cx - px * len, cy - py * len);
            g.lineTo(cx + px * len, cy + py * len);
            g.stroke();
        }
    }

    /**
     * **扇形**：从顶点向外快速铺开的扇面（2026-11 新增）。
     *
     * 用户口径：「如果要大范围，可以是扇形，但也要有所表现，比如从中心向外快速扩散」。
     * 所以画法是"**三条错开的外扩弧 + 扇面内的径向排线 + 弧两端的边界刻度**"：
     *   · **弧**回答"推出去多远"（半径 = 真实作用半径，与 Blast 同一条硬口径）；
     *   · **径向排线**回答"朝哪个方向、盖住了哪一片"（这是圆做不到的事 —— 圆没有朝向）；
     *   · **两端刻度**是制图里"尺寸线两端"的语法，读作"扇面的边界正好在这里"。
     *
     * 半径走 `fanGrowPow`（0.45 < Blast 的 0.55）→ **起步更快**：这是"一瞬间的出手"，
     * 不是"炸开之后慢慢散"。
     *
     * ⚠ 用折线逼近弧（`fanArcSegments` 段），不调 `Graphics.arc`：
     *   ① 全工程只用 `moveTo/lineTo/circle`，横向一致；② 体检脚本的假画布也只记这三种，
     *   用 `arc` 会让"画了几段"这条断言失真。
     */
    private drawFan(g: Graphics, it: ShapeItem): void {
        const ageMs = it.age * 1000;
        const totalMs = it.life * 1000;
        const to = Math.max(
            HIT_FEEL_SHAPE.fanMinRadiusPx,
            Math.min(it.radius, HIT_FEEL_SHAPE.fanRadiusDrawMax),
        );
        const base = Math.atan2(it.dirY, it.dirX);
        const half = (it.halfAngleDeg * Math.PI) / 180;
        const a0 = base - half;
        const a1 = base + half;
        const segs = Math.max(2, HIT_FEEL_SHAPE.fanArcSegments);

        // ① 逐层外扩的三条弧（起步快、末段收）
        const rings = Math.max(1, HIT_FEEL_SHAPE.fanRings);
        let outer = 0;
        for (let i = 0; i < rings; i++) {
            const ti = (ageMs - i * HIT_FEEL_SHAPE.fanRingStaggerMs)
                / (totalMs / rings + HIT_FEEL_SHAPE.fanRingStaggerMs);
            if (ti < 0 || ti >= 1) continue;
            const ratio = rings <= 1 ? 1 : 0.7 + 0.3 * (i / (rings - 1));
            const r = Math.max(2, to * ratio * Math.pow(ti, HIT_FEEL_SHAPE.fanGrowPow));
            if (r > outer) outer = r;
            polyArc(g, it.cx, it.cy, r, a0, a1, segs);
            g.stroke();
        }

        // ② 扇面内的径向排线：每条都从**顶点**出发（自带方向），长度跟当前外圈走
        const lines = Math.max(0, HIT_FEEL_SHAPE.fanRadialLines);
        if (lines > 0 && outer > 0) {
            for (let i = 0; i < lines; i++) {
                const a = a0 + ((i + 1) / (lines + 1)) * (a1 - a0);
                g.moveTo(it.cx, it.cy);
                g.lineTo(it.cx + Math.cos(a) * outer, it.cy + Math.sin(a) * outer);
            }
            g.stroke();
        }

        // ③ 两条边界（顶点 → 外圈两端）+ 端头刻度：只在扇面基本铺开之后画，读作"边界落定"
        if (outer > 0) {
            for (let i = 0; i <= 1; i++) {
                const a = i === 0 ? a0 : a1;
                const ex = it.cx + Math.cos(a) * outer;
                const ey = it.cy + Math.sin(a) * outer;
                g.moveTo(it.cx, it.cy);
                g.lineTo(ex, ey);
            }
            g.stroke();

            const done = ageMs / totalMs;
            if (done > 0.35) {
                const before = g.lineWidth;
                g.lineWidth = Math.max(HIT_FEEL_MARK.minLineWidth, HIT_FEEL_SHAPE.fanEdgeTickWidth * it.k);
                const halfTick = (HIT_FEEL_SHAPE.fanEdgeTickLen * it.k) * 0.5;
                for (let i = 0; i <= 1; i++) {
                    const a = i === 0 ? a0 : a1;
                    // 刻度垂直于半径方向
                    const nx = -Math.sin(a);
                    const ny = Math.cos(a);
                    const ex = it.cx + Math.cos(a) * outer;
                    const ey = it.cy + Math.sin(a) * outer;
                    g.moveTo(ex - nx * halfTick, ey - ny * halfTick);
                    g.lineTo(ex + nx * halfTick, ey + ny * halfTick);
                }
                g.stroke();
                g.lineWidth = before;
            }
        }
    }

    /** 画一个印痕（细环 → 刻度 → 对位十字；三种图元各有自己的寿命与淡出曲线） */
    private drawMark(g: Graphics, it: VfxItem): void {
        const spec = getTierSpec(it.tier).mark;
        const k = it.k;
        const rgb = it.heroHurt ? HIT_FEEL_MARK.heroRed : HIT_FEEL_MARK.ink;
        const ageMs = it.age * 1000;
        const px = -it.dirY;                                   // 垂直于伤害方向
        const py = it.dirX;

        // ---- 细环：由内向外、逐层延迟 → 读作"一波一波扩散"，不是"同心圈叠着" ----
        const rings = spec.rings;
        for (let i = 0; i < rings; i++) {
            const delay = i * HIT_FEEL_MARK.ringStaggerMs;
            const ti = (ageMs - delay) / HIT_FEEL_MARK.ringLifeMs;
            if (ti < 0 || ti >= 1) continue;
            const ratio = rings <= 1
                ? 1
                : HIT_FEEL_MARK.ringInnerRatio + (1 - HIT_FEEL_MARK.ringInnerRatio) * (i / (rings - 1));
            const to = Math.max(HIT_FEEL_MARK.ringFrom, spec.ringRadius * k * ratio);
            const r = HIT_FEEL_MARK.ringFrom
                + (to - HIT_FEEL_MARK.ringFrom) * Math.pow(ti, HIT_FEEL_MARK.ringGrowPow);
            this.setPaint(g, rgb, HIT_FEEL_MARK.ringAlpha * (1 - ti));
            g.lineWidth = Math.max(HIT_FEEL_MARK.minLineWidth, spec.lineWidth * k);
            g.circle(it.x, it.y, r);                            // 只描边不填充（GraphCircle 的既有口径）
            g.stroke();
        }

        // ---- 刻度：垂直于伤害方向的一排短线，整组沿伤害方向外移（"被这一下顶开"）----
        const ticks = spec.ticks;
        const tickTi = ageMs / HIT_FEEL_MARK.tickLifeMs;
        if (ticks > 0 && tickTi < 1) {
            const half = HIT_FEEL_MARK.tickLength * k * 0.5;
            const gap = HIT_FEEL_MARK.tickGap * k;
            // 奇数条正好有一条压在命中点上，偶数条左右对称
            const drift = HIT_FEEL_MARK.tickDrift * k * easeOutCubic(tickTi);
            this.setPaint(g, rgb, Math.pow(1 - tickTi, HIT_FEEL_MARK.tickFadePow));
            g.lineWidth = Math.max(HIT_FEEL_MARK.minLineWidth, HIT_FEEL_MARK.tickWidth * k);
            for (let i = 0; i < ticks; i++) {
                const off = (i - (ticks - 1) * 0.5) * gap + drift;
                const cx = it.x + it.dirX * off;
                const cy = it.y + it.dirY * off;
                g.moveTo(cx - px * half, cy - py * half);
                g.lineTo(cx + px * half, cy + py * half);
            }
            g.stroke();
        }

        // ---- 对位十字：暴击的**形状**签名（颜色一律不参与，见 §2 口径 4）----
        if (spec.cross) {
            const crossTi = ageMs / HIT_FEEL_MARK.crossLifeMs;
            if (crossTi < 1) {
                const arm = HIT_FEEL_MARK.crossArm * k;
                this.setPaint(g, rgb, 1 - crossTi);
                g.lineWidth = Math.max(HIT_FEEL_MARK.minLineWidth, HIT_FEEL_MARK.crossWidth * k);
                g.moveTo(it.x - it.dirX * arm, it.y - it.dirY * arm);
                g.lineTo(it.x + it.dirX * arm, it.y + it.dirY * arm);
                g.moveTo(it.x + px * arm, it.y + py * arm);
                g.lineTo(it.x - px * arm, it.y - py * arm);
                g.stroke();
            }
        }
    }

    /** 画起手印痕（一段朝目标滑出的虚线；虚线段一次 stroke 画完） */
    private drawAttack(g: Graphics, it: VfxItem): void {
        const ti = it.age / it.life;
        if (ti >= 1) return;
        const slide = HIT_FEEL_MARK.attackSlide * easeOutCubic(ti);
        const ox = it.x + it.dirX * slide;
        const oy = it.y + it.dirY * slide;
        this.setPaint(g, HIT_FEEL_MARK.inkSoft, HIT_FEEL_MARK.attackAlpha * (1 - ti));
        g.lineWidth = Math.max(HIT_FEEL_MARK.minLineWidth, HIT_FEEL_MARK.attackWidth);
        const step = HIT_FEEL_MARK.attackDashLen + HIT_FEEL_MARK.attackDashGap;
        for (let i = 0; i < HIT_FEEL_MARK.attackDashes; i++) {
            const d0 = i * step;
            const d1 = d0 + HIT_FEEL_MARK.attackDashLen;
            g.moveTo(ox + it.dirX * d0, oy + it.dirY * d0);
            g.lineTo(ox + it.dirX * d1, oy + it.dirY * d1);
        }
        g.stroke();
    }

    /**
     * 画闪避斜杠（左下 → 右上的一道短线；起手即满、线性淡出）
     *
     * 与印痕同一套"实线的一瞬"语法，但更淡：闪避不是"打中了"，而是"这一下落空了"。
     */
    private drawEvade(g: Graphics, it: VfxItem): void {
        const t = it.age / it.life;
        if (t >= 1) return;
        const k = it.k;
        const half = HIT_FEEL_MARK.evadeLen * k * 0.5;
        this.setPaint(g, HIT_FEEL_MARK.inkSoft, 1 - t);
        g.lineWidth = Math.max(HIT_FEEL_MARK.minLineWidth, HIT_FEEL_MARK.evadeWidth * k);
        g.moveTo(it.x - half, it.y - half);
        g.lineTo(it.x + half, it.y + half);
        g.stroke();
    }

    /** 画一块碎片（位置用闭式解，见 `spawnShards`） */
    private drawShard(g: Graphics, s: ShardItem): void {
        const t = s.age / s.life;
        if (t >= 1) return;
        const travel = t - 0.5 * HIT_FEEL_MARK.shardDecay * t * t;
        const x = s.x0 + s.vx * travel * s.life;
        const y = s.y0 + s.vy * travel * s.life;
        const half = s.size * 0.5;
        this.setPaint(g, s.color, 1 - t);
        g.rect(x - half, y - half, s.size, s.size);
        g.fill();
    }

    /**
     * 设置当前画笔色（描边 + 填充同时设）
     *
     * Graphics 的 strokeColor/fillColor 是**在 stroke()/fill() 调用时**才被读走并烘进顶点色的
     * （见引擎 graphics-assembler 的 `Color.copy(_curColor, graphics.strokeColor)`），
     * 所以这里复用一个 Color 实例是安全的，不会串色。
     */
    private setPaint(g: Graphics, rgb: number, alpha: number): void {
        const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
        this.paint.set((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, Math.round(a * 255));
        g.strokeColor = this.paint;
        g.fillColor = this.paint;
    }
}

// ============ 数据类型（池化复用；绘制所需的一切都在这，不持有节点） ============

/**
 * 印痕种类（同一份数据对象池，靠它分派画法）
 *
 * 用普通 enum 而不是 `const enum`：本工程由 `transpileModule`（体检脚本）与编辑器两套编译路径处理，
 * `const enum` 在 isolatedModules 语义下的内联行为随 TS 版本变过，而这里的收益只有一个整数常量。
 */
enum VfxKind {
    /** 命中/死亡印痕（刻度 / 细环 / 对位十字） */
    Mark = 0,
    /** 起手印痕（朝目标的短虚线） */
    Attack = 1,
    /** 闪避斜杠（F3 几何符号） */
    Evade = 2,
}

/** 单个印痕的运行时数据 */
interface VfxItem {
    kind: VfxKind;
    /** 命中点 / 起笔点（逻辑坐标，绘制时零转换） */
    x: number;
    y: number;
    /** 伤害传播方向（单位向量，source → target） */
    dirX: number;
    dirY: number;
    /** 已存活时长 / 总寿命（秒） */
    age: number;
    life: number;
    /** 档位（起手印痕没有档位，固定 None） */
    tier: HitFeelTier;
    /** 出生时的密度系数 k（**出生即定**：不随后续密度变化，否则已在场的印痕会跳大小） */
    k: number;
    /** 是否打在英雄身上（决定颜色：这是颜色通道唯一的职责） */
    heroHurt: boolean;
    /** 合并进来的命中次数（质心加权用） */
    count: number;
}

/** 单块碎片的运行时数据（位置用闭式解，所以存的是出生点与初速，不是当前位置） */
interface ShardItem {
    x0: number;
    y0: number;
    vx: number;
    vy: number;
    size: number;
    /** 0xRRGGBB */
    color: number;
    age: number;
    life: number;
}

/** 一条待提交的命中（事件回调里预算好表现字段，避免提交时再读一次可能已过时的实体） */
interface PendingHit {
    uid: number;
    x: number;
    y: number;
    /** 已判好的档位（`resolveHitTier` 的唯一调用点在回调里） */
    tier: HitFeelTier;
    dirX: number;
    dirY: number;
    heroHurt: boolean;
}

/**
 * 一次「同源 + 同帧」的命中批次（= 一次普攻及其引发的全部技能伤害）。
 *
 * 形态推断的全部输入就是它：`hits` 是落点，`anchorUid` / `hasKill` 回答"这到底是不是一次技能"。
 */
interface PendingBatch {
    /** 来源实体 uid（-1 = 无来源，例如环境伤害） */
    srcUid: number;
    hits: PendingHit[];
    /** 普攻锚点目标的 uid（0 = 本批没有普攻锚点；-1 = 只有击杀锚点） */
    anchorUid: number;
    anchorX: number;
    anchorY: number;
    hasKill: boolean;
}

/** 一个形态图形的运行时数据（与 `VfxItem` 分开：淘汰规则与额度都是另一套） */
interface ShapeItem {
    kind: HitShapeKind;
    /** 中心 / 链首（逻辑坐标） */
    cx: number;
    cy: number;
    /** 爆炸的真实作用半径（像素；Chain/Multi 不用） */
    radius: number;
    /** 多段的段数 */
    stacks: number;
    /** 落点（扁平的 x,y 对；截断到 `SHAPE_POINT_MAX`） */
    pts: number[];
    /** **完整点集**的包围盒（全场扫线用；与 `pts` 的截断无关） */
    bbMinX: number;
    bbMaxX: number;
    bbMinY: number;
    bbMaxY: number;
    dirX: number;
    dirY: number;
    /** 扇形**半角**（度；只有 Fan 用 —— 其它形状恒为 0） */
    halfAngleDeg: number;
    age: number;
    life: number;
    k: number;
    heroHurt: boolean;
}

/** 印痕层统计（调试面板 / 体检脚本读它） */
export interface HitVfxStats {
    /** 建出的命中/死亡印痕数 */
    marks: number;
    /** 建出的起手印痕数 */
    attacks: number;
    /** 建出的闪避斜杠数（F3） */
    evades: number;
    /** 建出的碎片数（已含密度衰减后的实际块数） */
    shards: number;
    /** 被合并进已有印痕的次数（G2 生效的证据） */
    merged: number;
    /** 因每秒新建上限被丢弃的次数 */
    spawnDropped: number;
    /** 因并发上限被淘汰的印痕数 */
    evicted: number;
    /** 因并发上限被淘汰的碎片数 */
    shardsDropped: number;
    /** 印痕并发峰值（应恒 ≤ markAliveMax） */
    alivePeak: number;
    /** 真正重绘过的帧数（空场不重绘 → 它远小于总帧数） */
    redraws: number;
    /**
     * 因**单帧采样上限**（`HIT_FEEL_BUDGET.perFrameHitSampleMax`）而没有被逐段记录的命中数。
     *
     * 诊断用：这个数变大 ⇒ 这一局出现了**段数爆炸**（见 `battle/DamageMeter.ts` 的文件头）；
     * 它**不影响表现**（采样只喂形态推断，印痕本身另有 `markAliveMax` 淘汰）。
     */
    hitsDropped: number;

    // ---- B5 形态层（**与上面那批分开记**：额度不同、淘汰规则也不同）----
    /** 建出的形态图形总数 */
    shapes: number;
    /** 其中链式折线 */
    chains: number;
    /** 其中爆炸扩散环 */
    blasts: number;
    /** 其中多段叠印 */
    multis: number;
    /** 其中**扇形**（Boss 咆哮 / 神器天怒；2026-11 新增） */
    fans: number;
    /**
     * 其中由**战斗侧显式上报**建出来的个数（`OnSkillShape`，设计文档 §13.4 的"路 B"）。
     *
     * 与 `shapes` 的关系：`reported ≤ shapes`。两者的差就是"靠落点几何猜出来"的那部分 ——
     * 这个数掉到 0 而 `shapes` 还在涨，说明几何推断在独自支撑（上报点被改坏了）。
     */
    reported: number;
    /** 因每秒新建上限被丢弃的个数 */
    shapeSpawnDropped: number;
    /** 因并发上限被淘汰的个数 */
    shapesEvicted: number;
    /** 形态并发峰值（应恒 ≤ shapeAliveMax） */
    shapeAlivePeak: number;
    /** 因总量上限被丢弃、**退回了个体印痕**的个数（形式上是"降级"，不是"丢失"） */
    shapesDropped: number;
}

// ============ 纯函数小工具 ============

/** 该档是否画得出东西（全 0 = 不出印痕，如 None 档） */
function hasMarkShape(m: HitMarkSpec): boolean {
    return m.ticks > 0 || m.rings > 0 || m.cross || m.shards > 0;
}

/**
 * 一个印痕的总寿命（秒）= 各图元寿命的最大值。
 *
 * 环是**逐层延迟**的，所以最后一层的结束时刻是 `ringStaggerMs × (rings-1) + ringLifeMs`；
 * 漏掉那个 stagger 会让三环/四环的最后一层在扩散到一半时被整条清掉（读作"环断了一半"）。
 */
function markLifeSec(m: HitMarkSpec): number {
    let ms = 0;
    if (m.ticks > 0) ms = Math.max(ms, HIT_FEEL_MARK.tickLifeMs);
    if (m.cross) ms = Math.max(ms, HIT_FEEL_MARK.crossLifeMs);
    if (m.rings > 0) {
        ms = Math.max(ms, HIT_FEEL_MARK.ringLifeMs + HIT_FEEL_MARK.ringStaggerMs * (m.rings - 1));
    }
    return Math.max(0.05, ms / 1000);
}

/** 伤害传播方向（source → target，单位向量）；来源缺失/重合时返回 (0,0) 由画法兜底 */
function directionOf(source: any, target: any): { x: number; y: number } {
    const sp = source?.position;
    const tp = target?.position;
    if (!sp || !tp) return { x: 0, y: 0 };
    const dx = tp.x - sp.x;
    const dy = tp.y - sp.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 0)) return { x: 0, y: 0 };
    return { x: dx / len, y: dy / len };
}

/** 单位的碰撞半径（已含体型缩放；缺字段时退回 0 = 起笔点不额外外推） */
function radiusOf(entity: any): number {
    const r = entity?.collisionRadius;
    return typeof r === 'number' && r > 0 ? r : 0;
}

/** 稳定伪随机 0~1（同一输入恒等；不用 Math.random，体检脚本才能真跑同一发碎片） */
function hash01(seed: number): number {
    const h = Math.abs(seed * 2654435761) % 1024 / 1024;
    return h;
}

/** 上浮缓动：起步快、末段慢（与前摇虚线/刻度外移的"出手即最快"一致） */
function easeOutCubic(t: number): number {
    const inv = 1 - t;
    return 1 - inv * inv * inv;
}

/**
 * 用折线逼近一段圆弧（只 `moveTo`/`lineTo`，不调 `Graphics.arc`）。
 *
 * 为什么不用 `arc`：本层与体检脚本的契约是"记账画布只记 moveTo/lineTo/circle/rect"，
 * `arc` 会让"这一次扇面画了几段"变得不可断言（而"段数 = 常量表"正是形态层的核心断言之一）。
 */
function polyArc(g: Graphics, cx: number, cy: number, r: number, a0: number, a1: number, segs: number): void {
    for (let i = 0; i <= segs; i++) {
        const a = a0 + (a1 - a0) * (i / segs);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
    }
}

/** 扇形半角的夹取（缺省/脏值 → `fanDefaultHalfAngleDeg`；再夹到安全区间） */
function clampFanHalfAngle(deg: number): number {
    const fallback = HIT_FEEL_SHAPE.fanDefaultHalfAngleDeg;
    const v = Number.isFinite(deg) && deg > 0 ? deg : fallback;
    return Math.max(HIT_FEEL_SHAPE.fanMinHalfAngleDeg, Math.min(HIT_FEEL_SHAPE.fanMaxHalfAngleDeg, v));
}
