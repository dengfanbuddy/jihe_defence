import { _decorator, Component, Node } from 'cc';
import { Entity, BattleEvents } from '../../battle';
import { UnitKind } from '../../common/EntityVisualConfig';
import { HP_BAR } from '../../common/EntityHpBarConfig';
import { HitFlash } from './HitFlash';
import { HpBar } from './HpBar';
const { ccclass, property } = _decorator;


/**
 * EntityView —— 逻辑 Entity 的表现载体（挂在单位预制件的根节点上）
 *
 * 职责：
 *   1. 位置跟随（脏检查，逻辑驱动移动）
 *   2. **外观初始化**：绑定时按 Entity.unitKind 设底色 + 缩放（见 EntityVisualConfig）
 *   3. **受击闪烁**：订阅战斗总线的 OnTakeDamage，只处理打在自己身上的那次伤害
 *   4. **血条**：同一个受击事件驱动 —— 默认隐藏，受击时显示当前生命百分比（改宽度），
 *      未受击 2s 后隐藏（见 HpBar / EntityHpBarConfig；父预制件缩放的抵消口径也在那里）
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
 *   bind 里拿到的状态必须在 unbind 里还回去：退订事件 + 恢复原色/原缩放 + 隐藏血条。
 *   漏掉退订会导致池化复用后同一节点上叠着多个 handler（一只怪受击闪 N 次）。
 */
@ccclass('EntityView')
export class EntityView extends Component {
    entity: Entity = null;          // 绑定逻辑实体（不回引，单向）

    /** 本 View 对应的预制件路径（对象池回收时按此路径回桶） */
    prefabPath = '';

    /** 受击闪烁控制器（颜色 / 缩放 / 受击色；bind 时初始化，unbind 时复位） */
    private flash: HitFlash | null = null;

    /** 血条控制器（百分比宽度 / 2s 自动隐藏；bind 时 attach，unbind 时复位） */
    private hpBar: HpBar | null = null;

    /** 受击事件退订句柄（unbind 必须调用，否则池化复用会重复订阅） */
    private unsubHit: (() => void) | null = null;

    /** 上次同步到节点的位置（脏检查：位置没变就跳过 setPosition，省 transform 重算） */
    private _lastX = 0;
    private _lastY = 0;



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
        this.flash = this.flash ?? new HitFlash(this.node);
        this.flash.apply(entity.unitKind ?? UnitKind.Normal);

        // 2) 受击闪烁：订阅战斗总线，按 target 过滤出"打在自己身上"的伤害
        this.subscribeHit();

        // 3) 血条：默认隐藏，受击才显示（池化复用会换到另一只怪身上，所以每次 bind 都重挂 + 复位）
        //    onLoad 已预取过；这里兜底再查一次（预制件里换名字/动态改层级时仍能拿到）
        if (!this.hpBarNode) this.hpBarNode = this.node.getChildByName(HP_BAR.nodeName);
        this.hpBar = this.hpBar ?? new HpBar();
        this.hpBar.attach(this.hpBarNode);

        // 4) 初始位置同步（并记录，供 update 脏检查比对）
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
        // 受击闪烁到时恢复本色（放在最前面：实体死亡后位置不再同步，但颜色要收尾）
        if (this.flash) this.flash.tick(dt);
        // 血条计时同理必须排在死亡早退之前：怪死了血条也要按时收掉
        if (this.hpBar) this.hpBar.tick(dt);

        if (!this.entity || this.entity.IsDead()) return;
        const p = this.entity.position;
        // 位置没变 → 跳过 setPosition（静止怪/英雄不再每帧触发矩阵重算）
        if (p.x === this._lastX && p.y === this._lastY) return;
        // 位置同步（逻辑驱动移动，表现跟随）
        this.node.setPosition(p.x, p.y);
        this._lastX = p.x;
        this._lastY = p.y;
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

    /** 战斗总线 OnTakeDamage：只认打在自己身上的伤害（闪烁 + 血条，同一个入口驱动） */
    private onTakeDamage(e: any): void {
        if (!this.entity || e?.target !== this.entity) return;
        this.flash?.hit();
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
