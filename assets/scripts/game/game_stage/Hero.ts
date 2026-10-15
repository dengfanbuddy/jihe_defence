import { _decorator, Component, director, Node } from 'cc';
import { Entity } from '../battle';
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
 * 受击事件来源与 EntityView 一致（2026-11 改）：**由 `DamagePipeline` 第 7 阶段直调**
 * `entity.view.onTakeDamage(e)`，不订阅战斗总线 —— 理由见 `EntityView` 类注释
 * 「为什么不再每个实体各订阅一次总线」。`bind` 把 `entity.view` 指到自己（与 `EntityView.bind` 同口径），
 * `unbind` 断开；英雄受击**不做抖动/膨胀**（它是固定锚点，抖了会被读成"射程变了"）。
 */
@ccclass('Hero')
export class Hero extends Component {
    entity: Entity
    @property(GraphCircle)
    rangeCircle: GraphCircle

    /** 受击闪烁控制器 */
    private flash: HitFlash | null = null;

    start() {

    }

    update(deltaTime: number) {
        // 受击闪烁到时恢复本色
        this.flash?.tick(deltaTime);
    }

    bind(entity: Entity) {
        // 重新 bind（换英雄）时先清理上一次的染色，避免叠加
        this.unbind();
        this.entity = entity;
        entity.view = this;         // 反向引用（`DamagePipeline` 靠它直调本视图）

        // 外观：英雄不染底（保留预制件原色），缩放 ×1；受击色 FF4C4C
        this.flash = this.flash ?? new HitFlash(this.node);
        this.flash.apply(UnitKind.Hero);
    }

    /** 解绑：恢复外观 + 断开反向引用（与 EntityView.unbind 对称；节点回池复用时必须调，节点销毁时不用） */
    unbind() {
        this.flash?.reset();
        if (this.entity) {
            this.entity.view = null;    // 切断 Entity → View 反向引用（直调链的入口）
            this.entity = null;
        }
    }

    /**
     * 组件销毁兜底：**只断引用，不回滚表现**。
     *
     * 销毁流程里节点的子节点与先注册的组件已经先被销毁并 `_destruct()`（Sprite 的 `_color` → null），
     * 这时写 `sprite.color` 会抛 TypeError；而 `onDestroy` 抛异常会中断
     * `CCObject._deferredDestroy()` → 销毁队列不清空、每帧重复抛，
     * 且 `director.tick` 在绘制前被打断 → 画面永久卡在上一帧（详见 EntityView.onDestroy）。
     */
    onDestroy() {
        if (this.entity) {
            this.entity.view = null;
            this.entity = null;
        }
        this.flash = null;
    }

    /**
     * 受击反应（**由 `DamagePipeline` 直调**）：只染一下色。
     *
     * 同帧去重：段数爆炸时（一帧几万段全打在英雄身上）整套反应做一次就够 —— 画面完全一样。
     */
    onTakeDamage(e: any): void {
        const entity = this.entity;
        if (!entity || (e?.target && e.target !== entity)) return;
        const frame = director.getTotalFrames();
        if (this.reactFrame === frame) return;
        this.reactFrame = frame;
        this.flash?.hit();
    }

    /** 上一次做受击反应的帧号（同帧去重，见 `onTakeDamage`） */
    private reactFrame = -1;
}
