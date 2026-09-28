import { Node, UITransform, Widget } from 'cc';
import { HP_BAR } from '../../common/EntityHpBarConfig';

/**
 * ============================================================
 * HpBar —— 单位血条控制器（表现层，随 View 生命周期）
 * ============================================================
 *
 * 显示口径（需求）：
 *   默认隐藏 → 受击时显示当前生命百分比（**改宽度模拟**）→ 未受击 2s 后隐藏
 *
 * ---- 两个必须处理的坑 ----
 *
 * ① **父预制件缩放（"实际尺寸"）**
 *    血条是单位预制件根节点（按体型 ×1 / ×1.3 / ×1.5 / ×2，见 EntityVisualConfig）的子节点，
 *    直接继承父缩放的话，最终 Boss 的血条会变成 5×2 = 10 单位粗。
 *    本控制器把自己的 scale.y 设成 1/父节点世界缩放 →
 *    **世界高度恒等于 HP_BAR.worldHeight（5），与父预制件缩放无关**。
 *    长度则**不抵消**：它随体型一起放大，血条始终横跨身体（普通 20 → 最终 Boss 40）。
 *
 * ② **预制件里 hp_bar 挂着 Widget（LEFT|RIGHT 拉伸 + AlignMode.ALWAYS）**
 *    该 Widget 会在自身/父节点 transform 一变时把宽度改回"父节点宽度"，
 *    而单位每帧都在移动（位置一变就触发）→ 百分比宽度会被逐帧覆盖，血条永远是满的。
 *    所以 attach 时**把 Widget 关掉**：宽度的唯一写入方是本控制器。
 *    （关掉是安全的：它原本的作用"宽度=身体宽度"已经由本控制器的满血长度继承下来。）
 *
 * 计时用**帧驱动**而不是 scheduleOnce（同 HitFlash）：
 *   节点是对象池复用的，定时器会跨生命周期残留（回收后仍回调），
 *   tick 由 View 的 update 驱动，unbind 时 reset 一次即可彻底干净。
 *
 * 用法（EntityView，与 flash 同一套节奏）：
 *   this.hpBar.attach(this.hpBarNode);   // bind：绑定节点 + 关 Widget + 默认隐藏
 *   this.hpBar.hit(ratio);               // 受击：显示 + 写百分比宽度 + 重新计时
 *   this.hpBar.tick(dt);                 // 每帧：到点自动隐藏
 *   this.hpBar.reset();                  // unbind：隐藏 + 复位长度/缩放（回池必须调）
 */
export class HpBar {
    /** 血条节点（预制件根下的 hp_bar）；null = 该预制件没有血条 → 全部降级为 no-op */
    private node: Node | null = null;
    /** 血条节点的 UITransform（宽度就是百分比的表现载体） */
    private trans: UITransform | null = null;
    /** 满血长度（**本地单位** = 预制件里摆的宽度；随父节点缩放一起放大） */
    private fullWidth = 0;
    /** 隐藏倒计时（> 0 表示正在显示） */
    private remain = 0;

    /**
     * 绑定血条节点（可反复调用：池化复用、换预制件都走它）
     * @param node 血条节点；传 null / 已销毁节点 = 本 View 没有血条（后续调用全部 no-op）
     */
    attach(node: Node | null): void {
        if (!node || !node.isValid) {
            this.node = null;
            this.trans = null;
            return;
        }
        this.node = node;
        this.trans = node.getComponent(UITransform);

        // 满血长度只在**首次** attach 时记录：
        // 之后 width 会被百分比改写，再读就只能读到"上一只怪的残血长度"（节点是池化复用的）
        if (this.fullWidth <= 0 && this.trans) this.fullWidth = this.trans.width;

        // 关掉 Widget（详见文件头 ②）：否则它每帧把宽度拉回父节点宽度，百分比永远被覆盖
        const widget = node.getComponent(Widget);
        if (widget) widget.enabled = false;

        // 默认隐藏（需求：默认隐藏，受击才出现）+ 清计时
        this.remain = 0;
        node.active = false;
    }

    /**
     * 受击：显示血条并写入当前生命百分比（同时重置隐藏倒计时 —— 连击期间血条不会中途消失）
     * @param ratio 生命百分比 0~1（越界自动夹取）
     */
    hit(ratio: number): void {
        this.remain = HP_BAR.hideDelay;
        this.paint(ratio);
        if (this.node?.isValid && !this.node.active) this.node.active = true;
    }

    /** 每帧推进（由 View.update 驱动）：未受击满 hideDelay 秒后自动隐藏 */
    tick(dt: number): void {
        if (this.remain <= 0) return;
        this.remain -= dt;
        if (this.remain > 0) return;
        this.remain = 0;
        if (this.node?.isValid) this.node.active = false;
    }

    /**
     * 解绑/回收：立即隐藏 + 复位长度与缩放。
     * 与 attach 对称，**对象池复用必须调用** —— 否则下一只怪会带着上一只的残血血条出场。
     */
    reset(): void {
        this.remain = 0;
        const node = this.node;
        const trans = this.trans;
        if (!node?.isValid || !trans) return;
        node.active = false;
        trans.setContentSize(this.fullWidth, HP_BAR.worldHeight);
        node.setScale(1, 1, 1);
    }

    // ============ 内部 ============

    /**
     * 写血条：长度 = 满血长度 × 百分比；高度恒为世界高度
     *
     * 坐标系（父预制件缩放口径的唯一落点）：
     *   世界高度 = contentSize.height × node.scale.y × 父节点世界缩放.y
     * 想让世界高度恒等于 HP_BAR.worldHeight，就令 node.scale.y = 1 / 父节点世界缩放.y。
     *
     * `worldScale` 取值时引擎内部会先 `updateWorldTransform()`（见 node.ts 的 getter），
     * 所以拿到的是最新值 —— 即使父节点的缩放是本帧刚改的（HitFlash.apply 在 bind 里 setScale）也没问题。
     * 父缩放为 0 时退回 1（避免除零放大成 Infinity）。
     */
    private paint(ratio: number): void {
        const node = this.node;
        const trans = this.trans;
        if (!node?.isValid || !trans) return;

        // 夹取到 0~1（NaN 也走 0：`ratio > 0` 为 false）
        const pct = ratio > 0 ? (ratio < 1 ? ratio : 1) : 0;
        const parentScaleY = Math.abs(node.parent?.worldScale.y ?? 1);

        // scale.x 恒为 1：长度不走缩放（走 contentSize），也就随父节点缩放一起放大；
        // scale.y 抵消父节点缩放 → 世界高度恒为 HP_BAR.worldHeight
        node.setScale(1, parentScaleY > 0 ? 1 / parentScaleY : 1, 1);
        trans.setContentSize(this.fullWidth * pct, HP_BAR.worldHeight);
    }
}
