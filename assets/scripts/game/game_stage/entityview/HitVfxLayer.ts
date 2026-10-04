import { _decorator, Color, Component, Graphics, Node, UITransform } from 'cc';
import { BattleEvents } from '../../battle';
import type { BattleContext } from '../../battle';
import { UnitKind } from '../../common/EntityVisualConfig';
import {
    HIT_FEEL_BUDGET,
    HIT_FEEL_MARK,
    HIT_FEEL_TIER_RANK,
    HitFeelTier,
    HitMarkSpec,
    clampBattleDt,
    getTierSpec,
    resolveDeathTier,
    resolveHitTier,
} from '../../common/HitFeelConfig';
import { HitFeelDirector } from './HitFeelDirector';
const { ccclass } = _decorator;

/** 本层 UITransform 的覆盖尺寸（战场以原点为中心、刷怪半径 ≤ 800，取 4000 留足余量） */
const COVER_SIZE = 4000;

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

    /** 印痕新建时间戳（1s 滑动窗口，用来卡每秒新建上限） */
    private spawnTimes: number[] = [];

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
        spawnDropped: 0, evicted: 0, shardsDropped: 0, alivePeak: 0, redraws: 0,
    };

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
        this.spawnTimes.length = 0;
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
        this.freeItems.length = 0;
        this.freeShards.length = 0;
        this.spawnTimes.length = 0;
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

    // ============ 事件入口（三条总线） ============

    /** 命中：盖一个印痕（刻度 / 细环 / 对位十字 + 该档的碎片） */
    private onTakeDamage(e: any): void {
        const target = e?.target;
        if (!target?.position) return;
        const tier = resolveHitTier(e);
        const dir = directionOf(e?.source, target);
        this.spawnMark(
            target.position.x,
            target.position.y,
            tier,
            dir.x,
            dir.y,
            target.unitKind === UnitKind.Hero,
        );
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

    // ============ 每帧：推进 + 整层重绘 ============

    update(dt: number): void {
        const g = this.g;
        if (!g) return;

        // dt 先过掉帧守卫（掉帧不该让印痕"跳"一大步；见 HIT_FEEL_BUDGET.dtMinSec 的注释）
        const d = clampBattleDt(dt);
        this.clock += d;
        this.pruneSpawnTimes();

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

        // 2) 空场且上帧也没画过 → 省掉 clear()
        if (this.items.length === 0 && this.shards.length === 0 && !this.drewLastFrame) return;

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
        for (let i = 0; i < this.items.length; i++) {
            if (this.items[i].kind === VfxKind.Mark) this.drawMark(g, this.items[i]);
        }
        this.drewLastFrame = this.items.length > 0 || this.shards.length > 0;
        this.stats.redraws++;
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
