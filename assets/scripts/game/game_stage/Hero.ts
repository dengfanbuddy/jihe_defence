import { _decorator, Component, Node } from 'cc';
import { Entity, BattleEvents } from '../battle';
import { GraphCircle } from '../common/GraphCircle';
import { UnitKind } from '../common/EntityVisualConfig';
import { HitFlash } from './entityview/HitFlash';
const { ccclass, property } = _decorator;

/**
 * Hero —— 英雄节点上的表现组件（与怪物侧的 EntityView 同构，但英雄走的是场景里预置的节点）
 *
 * 外观口径（Hero 固定为 UnitKind.Hero，见 EntityVisualConfig）：
 *   底色：不染色（保留美术原色）、缩放 ×1（英雄为锚点，immovable）
 *   受击：染 FF4C4C，停留 0.08s 后恢复原色
 *
 * 受击事件来源与 EntityView 一致：BattleContext 的 per-battle EventBus（ctx.bus）的
 * OnTakeDamage，按 target 过滤；bind 时订阅、重新 bind/销毁时退订。
 */
@ccclass('Hero')
export class Hero extends Component {
    entity: Entity
    @property(GraphCircle)
    rangeCircle: GraphCircle

    /** 受击闪烁控制器 */
    private flash: HitFlash | null = null;
    /** 受击事件退订句柄 */
    private unsubHit: (() => void) | null = null;

    start() {

    }

    update(deltaTime: number) {
        // 受击闪烁到时恢复本色
        this.flash?.tick(deltaTime);
    }

    bind(entity: Entity) {
        // 重新 bind（换英雄）时先清理上一次的订阅与染色，避免叠加
        this.unbind();
        this.entity = entity;

        // 外观：英雄不染底（保留预制件原色），缩放 ×1；受击色 FF4C4C
        this.flash = this.flash ?? new HitFlash(this.node);
        this.flash.apply(UnitKind.Hero);

        const bus = entity?.ctxRef?.bus;
        if (bus) this.unsubHit = bus.onBattleEvent(BattleEvents.OnTakeDamage, this.onTakeDamage, this);
    }

    /** 解绑：退订 + 恢复外观（与 EntityView.unbind 对称；节点回池复用时必须调，节点销毁时不用） */
    unbind() {
        if (this.unsubHit) {
            this.unsubHit();
            this.unsubHit = null;
        }
        this.flash?.reset();
        this.entity = null;
    }

    /**
     * 组件销毁兜底：**只退订 + 断引用，不回滚表现**。
     *
     * 销毁流程里节点的子节点与先注册的组件已经先被销毁并 `_destruct()`（Sprite 的 `_color` → null），
     * 这时写 `sprite.color` 会抛 TypeError；而 `onDestroy` 抛异常会中断
     * `CCObject._deferredDestroy()` → 销毁队列不清空、每帧重复抛，
     * 且 `director.tick` 在绘制前被打断 → 画面永久卡在上一帧（详见 EntityView.onDestroy）。
     */
    onDestroy() {
        if (this.unsubHit) {
            this.unsubHit();
            this.unsubHit = null;
        }
        this.entity = null;
        this.flash = null;
    }

    /** 战斗总线 OnTakeDamage：只认打在自己身上的伤害 */
    private onTakeDamage(e: any): void {
        if (!this.entity || e?.target !== this.entity) return;
        this.flash?.hit();
    }
}
