import { Color, Node, Sprite } from 'cc';
import { UnitKind, UnitVisualStyle, getUnitVisualStyle } from '../../common/EntityVisualConfig';

/**
 * ============================================================
 * HitFlash —— 单位受击闪烁控制器（表现层，随 View 生命周期）
 * ============================================================
 *
 * 职责：把「单位类别」翻译成节点上的实际表现 ——
 *   1. 缩放：node.setScale(style.scale)（逻辑侧的碰撞半径用同一倍率，见 Entity.SetUnitKind）
 *   2. 底色：style.color（null = 保留预制件原色，英雄走这条）
 *   3. 受击闪烁：被伤害时染成 style.hitColor，停留 hitFlashDuration 秒后恢复底色
 *
 * 用**帧计时**而不是 scheduleOnce：
 *   节点是对象池复用的，定时器会跨生命周期残留（回收后仍回调），
 *   tick 由 View 的 update 驱动，unbind 时 reset 一次即可彻底干净。
 *
 * 用法（EntityView.bind / Hero.bind 一致）：
 *   this.flash = new HitFlash(this.node);
 *   this.flash.apply(UnitKind.Elite);  // 绑定时初始化外观
 *   this.flash.hit();                  // 收到受击事件时
 *   this.flash.tick(dt);               // 每帧（View.update）
 *   this.flash.reset();                // 解绑/回收：恢复原色与原缩放
 */
export class HitFlash {
    private node: Node;
    /** 目标 Sprite（节点自身优先，其次子节点）——没有则整体降级为 no-op */
    private sprite: Sprite | null = null;
    /** 预制件自带原色（首次解析时记录一次，回收不重置：池化复用时仍能还原美术原色） */
    private prefabColor: Color | null = null;

    /** 当前底色（受击结束后恢复到这个色） */
    private baseColor = new Color(255, 255, 255, 255);
    /** 当前受击色 */
    private hitColor = new Color(255, 255, 255, 255);
    /** 受击色停留时长（秒） */
    private duration = 0.08;
    /** 受击色剩余停留时间（> 0 表示正在闪） */
    private remain = 0;
    /** 是否已 apply 过外观（未 apply 前 reset 不动节点，避免把预制件原色误写成白色） */
    private applied = false;

    constructor(node: Node, sprite?: Sprite | null) {
        this.node = node;
        this.sprite = sprite ?? node.getComponent(Sprite) ?? node.getComponentInChildren(Sprite);
    }

    /** 是否正在受击闪烁中 */
    get isFlashing(): boolean {
        return this.remain > 0;
    }

    /**
     * 应用单位外观（绑定时调用，可反复调用：换英雄/换类别都靠它覆盖）
     * @param kind 单位表现类别
     * @param style 可选：显式指定表现参数（缺省按 kind 查表）
     */
    apply(kind: UnitKind, style?: UnitVisualStyle): void {
        const s = style ?? getUnitVisualStyle(kind);
        this.duration = s.hitFlashDuration;

        // 缩放：表现层节点放大（逻辑层实体分离用同一个倍率乘半径，保证推距与体型一致）
        this.node.setScale(s.scale, s.scale, 1);

        // 底色：color=null → 保留预制件原色（英雄等美术自带配色的单位）
        this.baseColor = s.color === null ? this.copyPrefabColor() : toColor(s.color);
        this.hitColor = toColor(s.hitColor);

        // 复位闪烁状态并立刻回到本色（池化复用时不会残留上一只怪的受击色）
        this.remain = 0;
        this.applied = true;
        this.paint(this.baseColor);
    }

    /** 受击：立刻染成受击色并重新计时（挨连击时刷新停留时长） */
    hit(): void {
        if (!this.sprite) return;
        this.remain = this.duration;
        this.paint(this.hitColor);
    }

    /** 每帧推进（由 View.update 驱动）：到时自动恢复底色 */
    tick(dt: number): void {
        if (this.remain <= 0) return;
        this.remain -= dt;
        if (this.remain <= 0) {
            this.remain = 0;
            this.paint(this.baseColor);
        }
    }

    /** 解绑/回收：恢复底色与原缩放，清空闪烁状态（对象池复用必须调用） */
    reset(): void {
        this.remain = 0;
        if (!this.applied) return; // 从未 apply 过 → 节点外观不属于本控制器，不动它
        this.paint(this.baseColor);
        // 节点可能正处于销毁流程（如 releasePrefabs 直接 destroy 节点）：已销毁的节点不再动
        if (this.node?.isValid) this.node.setScale(1, 1, 1);
    }

    // ============ 内部 ============

    /**
     * 写色：每次传入独立的 Color 实例（Cocos 的 setter 内部做 set 拷贝，不共享引用）
     *
     * ⚠ **必须判 `isValid`**：Sprite 可能**已经被销毁**（典型场景：节点销毁时子节点先于父节点组件被销毁，
     *   且同一节点上先注册的组件先销毁 —— 目标 Sprite 往往就是这两种情况之一）。
     *   Cocos 销毁组件时会跑 `_destruct()` 把对象字段一律置 null（`Sprite._color` → null），
     *   此时 `sprite.color = c` 会在引擎的 `UIRenderer.set color` 里读 null 的 `_color.equals()` → TypeError。
     *   危害远不止报错本身：这行通常发生在 `onDestroy` 里，而 `onDestroy` 是引擎 `CCObject._deferredDestroy()`
     *   调用的 —— 异常会让销毁队列**不清空**（下一帧从同一个对象重新抛），并且 `director.tick` 在
     *   `_deferredDestroy()` 之后（绘制/提交渲染之前）被打断，表现为**画面永久卡在上一帧**、控制台每帧刷同一条报错。
     */
    private paint(c: Color): void {
        const sprite = this.sprite;
        if (sprite && sprite.isValid) sprite.color = c;
    }

    /** 取预制件原色（首次调用时缓存；之后无论被染成什么色都还原到它） */
    private copyPrefabColor(): Color {
        if (!this.prefabColor) {
            const c = this.sprite?.isValid ? this.sprite.color : null;
            this.prefabColor = c ? new Color(c.r, c.g, c.b, c.a) : new Color(255, 255, 255, 255);
        }
        return new Color(this.prefabColor.r, this.prefabColor.g, this.prefabColor.b, this.prefabColor.a);
    }
}

/** 0xRRGGBB → cc.Color（不透明） */
export function toColor(hex: number): Color {
    return new Color((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff, 255);
}
