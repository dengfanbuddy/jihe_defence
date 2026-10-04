import { _decorator, Component, Node } from 'cc';
import { Entity, BattleEvents } from '../../battle';
import { UnitKind, getUnitVisualStyle } from '../../common/EntityVisualConfig';
import { HP_BAR } from '../../common/EntityHpBarConfig';
import { getTierSpec, resolveHitTier } from '../../common/HitFeelConfig';
import { HitFlash } from './HitFlash';
import { HitFeelDirector } from './HitFeelDirector';
import { HpBar } from './HpBar';
const { ccclass, property } = _decorator;


/**
 * EntityView —— 逻辑 Entity 的表现载体（挂在单位预制件的根节点上）
 *
 * 职责：
 *   1. 位置跟随（脏检查，逻辑驱动移动）
 *   2. **外观初始化**：绑定时按 Entity.unitKind 设底色 + 缩放（见 EntityVisualConfig）
 *   3. **受击反馈**：订阅战斗总线的 OnTakeDamage，只处理打在自己身上的那次伤害 ——
 *      染色（HitFlash）+ 血条（HpBar）+ **打击反馈**（抖动 / 膨胀 / 层级弹出，见下）
 *   4. **血条**：同一个受击事件驱动 —— 默认隐藏，受击时显示当前生命百分比（改宽度），
 *      未受击 2s 后隐藏（见 HpBar / EntityHpBarConfig；父预制件缩放的抵消口径也在那里）
 *
 * ---- 打击反馈（B1）：为什么在本类里做，而不是全丢给 HitFeelDirector ----
 *   `HitFeelDirector` 只管**全局**那几件事（顿帧 / 慢动作 / 战斗内容层位移 / 预算账本），
 *   而"这只怪自己抖一下、鼓一下"是**按目标分组**的表现 —— 本类已经订阅了同一个
 *   `OnTakeDamage`（和 HitFlash / HpBar 一条路），直接在这里做，不需要多一层中转。
 *   两处共用同一个判定函数 `resolveHitTier`（`common/HitFeelConfig.ts`），
 *   所以"这一下是几档"只有一处实现。
 *
 * ⚠ **抖动与膨胀只改表现层的东西**：
 *   · 位置 = `entity.position + 抖动 offset`（脏检查比对**最终写入值**）；
 *   · 缩放走 `HitFlash.deform`（它独占节点缩放 = 基准 × 膨胀，见那里注释）；
 *   · **绝不写回 `entity.position`** —— 那是 `Entity.ApplyKnockback` 的领域（逻辑位移，影响 AI 与索敌）。
 *
 * ⚠ 英雄不走本类（它挂的是 `game_stage/Hero.ts`）：英雄是**固定锚点**、节点下还挂着射程圈
 *   （`hero/range`），抖它或缩它都会读成"射程变了"。英雄受击的反馈 = 染色 + 方向性容器位移
 *   （由 director 出）—— 见 `docs/打击反馈设计.md` §4 的 T6。
 *
 * 事件来源说明（为什么不给 Entity 单独做一套事件系统）：
 *   BattleContext 已经有一条 per-battle 的 EventBus（ctx.bus），伤害管线在扣血后
 *   统一 publish(OnTakeDamage)，负载里带 target —— 视图层只需按 target 过滤即可。
 *   再往 Entity 里塞一个微型 emitter 会增加第二套事件语义（谁在何时订阅/解绑），
 *   而这些生命周期问题在这里已经用 unsub 句柄解决了。
 *   代价：每次伤害事件会遍历所有已订阅视图（过滤一次 === 比较），
 *   当前规模（同时存活几十只）可忽略；若将来实体数上千，再换成 Entity 侧回调。
 *
 * 对象池约定（EntityViewPool）：
 *   bind 里拿到的状态必须在 unbind 里还回去：退订事件 + 恢复原色/原缩放 + 隐藏血条
 *   + 清掉抖动/膨胀/层级弹出的残留。漏掉退订会导致池化复用后同一节点上叠着多个 handler
 *   （一只怪受击闪 N 次）。
 */
@ccclass('EntityView')
export class EntityView extends Component {
    entity: Entity = null;          // 绑定逻辑实体（不回引，单向）

    /** 本 View 对应的预制件路径（对象池回收时按此路径回桶） */
    prefabPath = '';

    /** 受击闪烁控制器（颜色 / 缩放 / 受击色 / 膨胀；bind 时初始化，unbind 时复位） */
    private flash: HitFlash | null = null;

    /** 血条控制器（百分比宽度 / 2s 自动隐藏；bind 时 attach，unbind 时复位） */
    private hpBar: HpBar | null = null;

    /** 受击事件退订句柄（unbind 必须调用，否则池化复用会重复订阅） */
    private unsubHit: (() => void) | null = null;

    /** 上次同步到节点的位置（脏检查：位置没变就跳过 setPosition，省 transform 重算） */
    private _lastX = 0;
    private _lastY = 0;

    /* ===== 打击反馈 B1：受击抖动（表现层 offset，帧驱动，池化复用必须复位）===== */
    /** 抖动幅度（像素，已乘密度衰减系数 k） */
    private shakeAmp = 0;
    /** 抖动方向（单位向量 = 伤害传播方向 source → target） */
    private shakeDirX = 0;
    private shakeDirY = 0;
    /** 抖动频率（Hz） */
    private shakeFreq = 0;
    /** 抖动总时长 / 已过时长 / 剩余时长（秒） */
    private shakeDur = 0;
    private shakeElapsed = 0;
    private shakeRemain = 0;
    /** 本帧的抖动 offset（叠加到节点位置，**不写 entity.position**） */
    private shakeOffX = 0;
    private shakeOffY = 0;

    /* ===== 打击反馈 B1：层级弹出（Z-Pop，怪群重叠时把被击中的那只短暂置顶）===== */
    /** 剩余弹出时长（秒）；> 0 = 正处于置顶态 */
    private zPopRemain = 0;
    /** 置顶前记录的 sibling 索引（-1 = 没有待还原的） */
    private zPopSavedIndex = -1;



    /** 血条节点（预制件根节点下的 hp_bar；名字见 EntityHpBarConfig.nodeName） */
    hpBarNode: Node = null;

    protected onLoad(): void {
        this.hpBarNode = this.node.getChildByName(HP_BAR.nodeName);
    }

    /** 表现层节点（子节点引用，可在预制件中绑定或运行时获取） */
    // @property(Node) body: Node = null;  // 预留：身体/动画节点

    /** 工厂创建后调用：绑定逻辑实体 + 记录预制件路径 + 初始化外观 + 订阅受击事件 */
    bind(entity: Entity, prefabPath = '') {
        this.entity = entity;
        this.prefabPath = prefabPath;
        entity.view = this;         // 反向引用（Entity 已有该字段）

        // 1) 外观初始化：按表现类别设底色 + 缩放
        //    （英雄不染底、普通怪 6B8E9B、精英 9B59B6、各 Boss 见 EntityVisualConfig）
        const kind = entity.unitKind ?? UnitKind.Normal;
        const style = getUnitVisualStyle(kind);
        this.flash = this.flash ?? new HitFlash(this.node);
        this.flash.apply(kind, style);

        // 2) 受击闪烁：订阅战斗总线，按 target 过滤出"打在自己身上"的伤害
        this.subscribeHit();

        // 3) 血条：默认隐藏，受击才显示（池化复用会换到另一只怪身上，所以每次 bind 都重挂 + 复位）
        //    onLoad 已预取过；这里兜底再查一次（预制件里换名字/动态改层级时仍能拿到）
        if (!this.hpBarNode) this.hpBarNode = this.node.getChildByName(HP_BAR.nodeName);
        this.hpBar = this.hpBar ?? new HpBar();
        // 高度补偿用**基准 scale**（不是瞬时世界缩放）：受击膨胀那一帧血条不该跟着跳高
        this.hpBar.attach(this.hpBarNode, style.scale);

        // 4) 打击反馈残留复位（上一次池化复用可能停在抖动/置顶态）
        this.resetHitFeel();

        // 5) 初始位置同步（并记录，供 update 脏检查比对）
        this.node.setPosition(entity.position.x, entity.position.y);
        this._lastX = entity.position.x;
        this._lastY = entity.position.y;
    }

    /**
     * 对象池回收前调用（节点**不销毁**、要回池复用）：退订事件 + 恢复外观 + 解除引用。
     * 「恢复外观」只在这里做 —— 节点都要销毁时走 `onDestroy`，那里不回滚表现。
     */
    unbind() {
        // 先退订：节点要回池复用，handler 不能跟着留
        this.unsubscribeHit();
        // 恢复本色与原缩放（受击中回收也不会把受击色带到下一只怪身上）
        if (this.flash) this.flash.reset();
        // 隐藏血条 + 复位长度（否则下一只怪出场就带着上一只的残血血条）
        if (this.hpBar) this.hpBar.reset();
        // 清掉抖动/置顶残留（节点马上要换父节点，这里不回滚 sibling 索引，只清计时器）
        this.resetHitFeel();
        if (this.entity) {
            this.entity.view = null; // 切断 Entity → View 反向引用
            this.entity = null;
        }
        // 若有子引用（血条/特效），一并解除
        this.node.setPosition(0, 0);
        this._lastX = 0;
        this._lastY = 0;
    }

    update(dt: number) {
        // 受击闪烁/膨胀到时恢复本色与基准缩放（放在最前面：实体死亡后位置不再同步，但外观要收尾）
        if (this.flash) this.flash.tick(dt);
        // 血条计时同理必须排在死亡早退之前：怪死了血条也要按时收掉
        if (this.hpBar) this.hpBar.tick(dt);
        // 打击反馈（抖动 / 置顶）同理：死了也要把残留还回去，否则池化复用会带着上一次的偏移出场
        this.tickHitFeel(dt);

        if (!this.entity || this.entity.IsDead()) return;
        const p = this.entity.position;
        // 位置 = 逻辑位置 + 抖动 offset（**脏检查比对最终写入值**：怪静止时靠 offset 才能看到抖动）
        const x = p.x + this.shakeOffX;
        const y = p.y + this.shakeOffY;
        // 没变 → 跳过 setPosition（静止怪/英雄不再每帧触发矩阵重算）
        if (x === this._lastX && y === this._lastY) return;
        // 位置同步（逻辑驱动移动，表现跟随）
        this.node.setPosition(x, y);
        this._lastX = x;
        this._lastY = y;
    }

    /**
     * 组件销毁兜底：**只退订 + 断引用，绝不碰表现**。
     *
     * 为什么不复用 `unbind()`：销毁流程里节点的子节点与先注册的组件**已经先被销毁**，
     * Cocos 的 `_destruct()` 会把它们的对象字段一律置 null（`Sprite._color` → null），
     * 这时再回滚颜色 / 缩放就会读到 null 抛 TypeError。
     * 而 `onDestroy` 是引擎 `CCObject._deferredDestroy()` 调的 —— 那里抛异常会让销毁队列不清空
     * （每帧从同一个对象重新抛），并且 `director.tick` 会在绘制之前被打断，
     * 表现为**画面永久卡在上一帧**（"退出战斗没回到主界面"就是这么来的）。
     * 何况节点马上就要销毁，颜色/缩放/位置没有任何回滚的意义。
     */
    onDestroy() {
        this.unsubscribeHit();
        if (this.entity) {
            this.entity.view = null; // 切断 Entity → View 反向引用（实体可能还活着）
            this.entity = null;
        }
        this.flash = null;
        this.hpBar = null;          // 只断引用：血条节点是子节点，销毁流程里它先被销毁，不能再碰
        // 打击反馈只清数据（**绝不在这里碰节点**，理由同上）
        this.shakeRemain = 0;
        this.shakeOffX = 0;
        this.shakeOffY = 0;
        this.zPopRemain = 0;
        this.zPopSavedIndex = -1;
    }

    // ============ 打击反馈（B1：抖动 / 膨胀 / 层级弹出）============

    /**
     * 每帧推进打击反馈（由 `update` 驱动，**排在死亡早退之前**）
     *
     * 抖动曲线：起手即最大 → 沿伤害方向往复振荡 → 线性衰减到 0（"高频小幅"才像被打到）。
     * 与 `HitFlash` / `HpBar` 同一套帧计时口径：**不用 schedule/tween**，
     * 因为节点是池化复用的，定时器会跨生命周期残留。
     */
    private tickHitFeel(dt: number): void {
        if (this.shakeRemain > 0) {
            this.shakeElapsed += dt;
            this.shakeRemain -= dt;
            if (this.shakeRemain <= 0) {
                this.shakeRemain = 0;
                this.shakeOffX = 0;
                this.shakeOffY = 0;
            } else {
                const t = this.shakeDur > 0 ? this.shakeElapsed / this.shakeDur : 1;
                const decay = 1 - (t > 1 ? 1 : t);
                const phase = this.shakeElapsed * this.shakeFreq * Math.PI * 2;
                const off = this.shakeAmp * decay * Math.sin(phase);
                this.shakeOffX = this.shakeDirX * off;
                this.shakeOffY = this.shakeDirY * off;
            }
        }
        if (this.zPopRemain > 0) {
            this.zPopRemain -= dt;
            if (this.zPopRemain <= 0) {
                this.zPopRemain = 0;
                this.restoreSiblingIndex();
            }
        }
    }

    /** 复位打击反馈状态（bind / unbind 用；**不还原 sibling 索引** —— 节点正要换父节点） */
    private resetHitFeel(): void {
        this.shakeAmp = 0;
        this.shakeRemain = 0;
        this.shakeElapsed = 0;
        this.shakeDur = 0;
        this.shakeFreq = 0;
        this.shakeOffX = 0;
        this.shakeOffY = 0;
        this.zPopRemain = 0;
        this.zPopSavedIndex = -1;
    }

    /** 受击：按档位启动抖动 / 膨胀 / 置顶（三者的数值全部来自 HitFeelConfig 的档位表） */
    private applyHitReaction(e: any): void {
        const spec = getTierSpec(resolveHitTier(e));
        // 幅度类表现统一乘密度衰减系数 k（后期 3 次/秒 × 怪群时把表现压细，见设计文档 §5.4）
        const k = HitFeelDirector.active?.densityScale ?? 1;

        this.startShake(spec.hitShakePx * k, spec.hitShakeMs, spec.hitShakeFreq, e);
        if (spec.punchPct > 0) this.flash?.deform(spec.punchPct, spec.punchMs);
        if (spec.zPopMs > 0) this.startZPop(spec.zPopMs);
    }

    /**
     * 启动受击抖动（连击时**刷新**而不是叠加：3 次/秒的普攻不能把怪摇成残影）
     *
     * @param amp  幅度（像素）
     * @param ms   时长（毫秒）
     * @param freq 频率（Hz）
     * @param e    伤害事件（用来取"伤害传播方向"= source → target）
     */
    private startShake(amp: number, ms: number, freq: number, e: any): void {
        if (!(amp > 0) || !(ms > 0)) return;
        this.shakeAmp = amp;
        this.shakeDur = ms / 1000;
        this.shakeRemain = this.shakeDur;
        this.shakeElapsed = 0;
        this.shakeFreq = freq > 0 ? freq : 20;
        const dir = this.hitDirection(e);
        this.shakeDirX = dir.x;
        this.shakeDirY = dir.y;
        this.shakeOffX = 0;
        this.shakeOffY = 0;
    }

    /**
     * 伤害传播方向（source → target，单位向量）。
     *
     * 用**方向性**而不是随机抖：玩家能读出"这一下是从哪边打过来的"。
     * 来源缺失/重合（DoT 无来源、同点命中）→ 退化成竖直方向（仍然看得见抖动，不会静默失效）。
     */
    private hitDirection(e: any): { x: number; y: number } {
        const sp = e?.source?.position;
        const tp = e?.target?.position ?? this.entity?.position;
        if (!sp || !tp) return { x: 0, y: 1 };
        const dx = tp.x - sp.x;
        const dy = tp.y - sp.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (!(len > 0)) return { x: 0, y: 1 };
        return { x: dx / len, y: dy / len };
    }

    /**
     * 层级弹出：把被击中的那只短暂挪到兄弟末尾（= 画在最上层）。
     *
     * 为什么塔防需要它：碰撞半径只有 10~40px，怪群必然互相重叠，
     * 被打的那只如果被压在别的怪下面，玩家根本看不见反馈。
     *
     * ⚠ 必须**记原索引**并在到点/复用时还原；`unbind` 里只清计时器（节点马上要换父节点）。
     * 还原时索引要夹取 —— 这期间兄弟可能已被回收，直接用旧索引会越界。
     */
    private startZPop(ms: number): void {
        const parent = this.node?.parent;
        if (!parent || !this.node.isValid) return;
        if (this.zPopRemain <= 0) this.zPopSavedIndex = this.node.getSiblingIndex();
        const last = parent.children.length - 1;
        if (last > 0 && this.node.getSiblingIndex() !== last) this.node.setSiblingIndex(last);
        this.zPopRemain = ms / 1000;
    }

    /** 还原置顶前的 sibling 索引（越界自动夹取；节点已销毁/无父节点则放弃） */
    private restoreSiblingIndex(): void {
        const idx = this.zPopSavedIndex;
        this.zPopSavedIndex = -1;
        if (idx < 0) return;
        const node = this.node;
        const parent = node?.parent;
        if (!node?.isValid || !parent) return;
        const max = parent.children.length - 1;
        if (max < 0) return;
        node.setSiblingIndex(idx > max ? max : idx);
    }

    // ============ 受击事件 ============
    /** 订阅受击事件（重复调用安全：先退订再订阅） */
    private subscribeHit(): void {
        this.unsubscribeHit();
        const bus = this.entity?.ctxRef?.bus;
        if (!bus) return;
        // 句柄式退订：handler 是每次新建的闭包，靠返回的 unsubscribe 精确移除
        this.unsubHit = bus.onBattleEvent(BattleEvents.OnTakeDamage, this.onTakeDamage, this);
    }

    /** 退订受击事件 */
    private unsubscribeHit(): void {
        if (this.unsubHit) {
            this.unsubHit();
            this.unsubHit = null;
        }
    }

    /** 战斗总线 OnTakeDamage：只认打在自己身上的伤害（闪烁 + 血条 + 打击反馈，同一个入口驱动） */
    private onTakeDamage(e: any): void {
        if (!this.entity || e?.target !== this.entity) return;
        this.flash?.hit();
        // 打击反馈（B1）：抖动 / 膨胀 / 层级弹出（档位来自 HitFeelConfig，与全局表现共用判定）
        this.applyHitReaction(e);
        // 事件发生在扣血之后（DamagePipeline Phase 6 先 ChangeHp、Phase 7 才 publish），
        // 所以这里读到的 entity.hp 就是"这一击之后"的血量 → 血条显示的是实时百分比
        this.hpBar?.hit(this.hpRatio());
    }

    /** 当前生命百分比 0~1（上限取属性系统的 MaxHp；上限为 0 时按 0 处理） */
    private hpRatio(): number {
        const max = this.entity.getMaxHp();
        return max > 0 ? this.entity.hp / max : 0;
    }
}
