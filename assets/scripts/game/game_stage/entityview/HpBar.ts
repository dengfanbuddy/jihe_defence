import { Color, Node, Sprite, UITransform, Widget } from 'cc';
import { HP_BAR } from '../../common/EntityHpBarConfig';

/**
 * ============================================================
 * HpBar —— 单位血条控制器（表现层，随 View 生命周期）
 * ============================================================
 *
 * 显示口径（需求）：
 *   默认隐藏 → 受击时显示当前生命百分比（**改宽度模拟**）→ 未受击 2s 后隐藏
 *
 * ---- 打击反馈 B3（F6）：延迟掉血条（残影条）----
 * 血条**瞬时**跳到新百分比（那是"结果"），另有一条**残影条**停在原处、0.6s 内先快后慢地贴上来 ——
 * 两者之差就是"这一下打掉了多少"，一眼读得出来。三条口径：
 *   ① 残影条是**兄弟节点**（单位根节点下、插在 hp_bar 之前 = 画在血条下面），
 *      **不是 hp_bar 的子节点** —— 父节点的 Sprite 先画、子节点后画，挂下面会盖在血条上（正好反了）；
 *   ② 它**借 hp_bar 的 SpriteFrame**，不新增资源、不做异步 load（异步在池化组件里是生命周期雷区）；
 *   ③ 它**不是"白色的残影"**而是墨色 α0.45 —— 浅底上白条等于没画（详见 EntityHpBarConfig 的注释）。
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
 *    ⚠ 抵消用的父缩放是 **bind 时传入的基准 scale**（= `UNIT_VISUALS.scale`），
 *      **不是**每帧现读的 `node.parent.worldScale.y` —— 打击反馈会给根节点做**受击膨胀**
 *      （`HitFlash.deform`，瞬间 ×1.06~1.13 再弹回），若跟着现读，
 *      受击那一帧血条会突然变矮（世界高度恒定的不变量被打破）。
 *      基准 scale 只在换体型时变，正是"不变量"该用的量。
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
 *   this.hpBar.attach(this.hpBarNode, style.scale);   // bind：绑节点 + 关 Widget + 建残影条 + 默认隐藏
 *   this.hpBar.hit(ratio);                           // 受击：显示 + 写百分比宽度 + 残影条开始追 + 重新计时
 *   this.hpBar.tick(dt);                             // 每帧：残影条追赶 + 到点自动隐藏
 *   this.hpBar.reset();                              // unbind：隐藏 + 复位长度/缩放/残影条（回池必须调）
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
     * 父节点（单位根节点）的**基准缩放** —— 高度补偿的分母。
     * 由 `attach` 传入（= `UNIT_VISUALS.scale`），**不随受击膨胀变化**（见文件头 ① 的 ⚠）。
     */
    private baseParentScale = 1;

    /* ===== 延迟掉血条（残影条，B3 / F6）===== */
    /** 残影条节点（运行时在单位根节点下创建；null = 借不到 SpriteFrame → 本特性降级为 no-op） */
    private lagNode: Node | null = null;
    private lagTrans: UITransform | null = null;
    /** 血条当前百分比（残影条的追赶目标） */
    private hpPct = 1;
    /** 残影条当前百分比（恒 ≥ hpPct；两者相等时它整条被压在血条下 = 看不见） */
    private lagPct = 1;
    /** 本次追赶的起点百分比（每次掉血都从"当前残影位置"重新起跑） */
    private lagFrom = 1;
    /** 追赶剩余时间（秒）；<= 0 = 已追上 */
    private lagRemain = 0;
    /** 残影条颜色（复用同一个 Color：`Sprite.color` 的 setter 内部做拷贝，不会串色） */
    private readonly lagPaint = new Color(
        (HP_BAR.lagColor >> 16) & 0xff,
        (HP_BAR.lagColor >> 8) & 0xff,
        HP_BAR.lagColor & 0xff,
        Math.round(HP_BAR.lagAlpha * 255),
    );

    /**
     * 绑定血条节点（可反复调用：池化复用、换预制件都走它）
     * @param node 血条节点；传 null / 已销毁节点 = 本 View 没有血条（后续调用全部 no-op）
     * @param baseParentScale 单位根节点的**基准缩放**（`UNIT_VISUALS.scale`）；
     *                        缺省 1。**不要传瞬时 worldScale** —— 受击膨胀会让血条跳高
     */
    attach(node: Node | null, baseParentScale = 1): void {
        this.baseParentScale = baseParentScale > 0 ? baseParentScale : 1;
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

        // 残影条（B3 / F6）：取或建 + 对齐 + 复位到"满血且已追上"
        this.ensureLagNode();
        this.hpPct = 1;
        this.lagPct = 1;
        this.lagFrom = 1;
        this.lagRemain = 0;
        // 顺手把**血条本身**也归一化（宽度=满血、scale.y=高度补偿）：
        // attach 之后节点就是"满血待命"的干净状态，不依赖上一只怪 unbind 时的 reset
        this.paint(1);

        // 默认隐藏（需求：默认隐藏，受击才出现）+ 清计时
        this.remain = 0;
        node.active = false;
        if (this.lagNode?.isValid) this.lagNode.active = false;
    }

    /**
     * 受击：显示血条并写入当前生命百分比（同时重置隐藏倒计时 —— 连击期间血条不会中途消失）
     * @param ratio 生命百分比 0~1（越界自动夹取）
     */
    hit(ratio: number): void {
        this.remain = HP_BAR.hideDelay;
        this.paint(ratio);
        if (this.node?.isValid && !this.node.active) this.node.active = true;
        if (this.lagNode?.isValid && !this.lagNode.active) this.lagNode.active = true;
    }

    /** 每帧推进（由 View.update 驱动）：残影条追赶 + 未受击满 hideDelay 秒后自动隐藏 */
    tick(dt: number): void {
        this.tickLag(dt);
        if (this.remain <= 0) return;
        this.remain -= dt;
        if (this.remain > 0) return;
        this.remain = 0;
        if (this.node?.isValid) this.node.active = false;
        if (this.lagNode?.isValid) this.lagNode.active = false;
    }

    /**
     * 解绑/回收：立即隐藏 + 复位长度与缩放（含残影条）。
     * 与 attach 对称，**对象池复用必须调用** —— 否则下一只怪会带着上一只的残血血条出场。
     */
    reset(): void {
        this.remain = 0;
        this.hpPct = 1;
        this.lagPct = 1;
        this.lagFrom = 1;
        this.lagRemain = 0;
        const node = this.node;
        const trans = this.trans;
        if (!node?.isValid || !trans) return;
        node.active = false;
        trans.setContentSize(this.fullWidth, HP_BAR.worldHeight);
        node.setScale(1, 1, 1);
        const lag = this.lagNode;
        if (lag?.isValid) {
            lag.active = false;
            const lagTrans = this.lagTrans;
            if (lagTrans) lagTrans.setContentSize(this.fullWidth, HP_BAR.worldHeight);
            lag.setScale(1, 1, 1);
        }
    }

    // ============ 内部 ============

    /**
     * 写血条：长度 = 满血长度 × 百分比；高度恒为世界高度
     *
     * 坐标系（父预制件缩放口径的唯一落点）：
     *   世界高度 = contentSize.height × node.scale.y × 父节点世界缩放.y
     * 想让世界高度恒等于 HP_BAR.worldHeight，就令 node.scale.y = 1 / 父节点**基准**缩放.y
     * （父缩放取 `attach` 传入的基准值，理由见文件头 ① 的 ⚠：受击膨胀是瞬时表现，不能参与这个除法）。
     * 父缩放为 0 时退回 1（避免除零放大成 Infinity）。
     */
    private paint(ratio: number): void {
        const node = this.node;
        const trans = this.trans;
        if (!node?.isValid || !trans) return;

        // 夹取到 0~1（NaN 也走 0：`ratio > 0` 为 false）
        const pct = ratio > 0 ? (ratio < 1 ? ratio : 1) : 0;
        const parentScaleY = this.baseParentScale;

        // scale.x 恒为 1：长度不走缩放（走 contentSize），也就随父节点缩放一起放大；
        // scale.y 抵消父节点缩放 → 世界高度恒为 HP_BAR.worldHeight
        const sy = parentScaleY > 0 ? 1 / parentScaleY : 1;
        node.setScale(1, sy, 1);
        trans.setContentSize(this.fullWidth * pct, HP_BAR.worldHeight);
        if (this.lagNode?.isValid) this.lagNode.setScale(1, sy, 1);

        // 延迟条（F6）：**血条瞬时到位，残影条从原处追上来**
        //   掉血（pct 变小）→ 从"当前残影位置"重新起跑，追到新的血条位置；
        //   回血/首次（pct ≥ 残影）→ 直接跟到位（追"回血"没有信息量，反而像卡了一下）。
        this.hpPct = pct;
        if (pct < this.lagPct) {
            this.lagFrom = this.lagPct;
            this.lagRemain = HP_BAR.lagSec;
        } else {
            this.lagFrom = pct;
            this.lagPct = pct;
            this.lagRemain = 0;
        }
        this.paintLag();
    }

    /** 推进残影条（ease-out：先快后慢地贴上血条） */
    private tickLag(dt: number): void {
        if (this.lagRemain <= 0) return;
        this.lagRemain -= dt;
        if (this.lagRemain <= 0) {
            this.lagRemain = 0;
            this.lagPct = this.hpPct;
        } else {
            const t = 1 - this.lagRemain / HP_BAR.lagSec;
            this.lagPct = this.lagFrom - (this.lagFrom - this.hpPct) * easeOutCubic(t);
        }
        this.paintLag();
    }

    /** 写残影条宽度（**恒 ≥ 血条**：等长时它整条被压在血条下面，等于看不见） */
    private paintLag(): void {
        const lag = this.lagNode;
        const trans = this.lagTrans;
        if (!lag?.isValid || !trans) return;
        const pct = this.lagPct > this.hpPct ? this.lagPct : this.hpPct;
        trans.setContentSize(this.fullWidth * pct, HP_BAR.worldHeight);
    }

    /**
     * 取（必要时创建）残影条节点（**运行时创建，不改预制件**）
     *
     * ① 每次都按名字重查：节点是池化复用的，"换的是哪只怪"而不是"换哪个节点"；
     * ② **借 hp_bar 的 SpriteFrame**（不新增资源、不做异步 load）；借不到就整特性降级为 no-op；
     * ③ `new Node()` 的 layer 默认**不是 UI_2D**（UI 相机会看不到），必须显式继承；
     * ④ 插在 hp_bar **之前**（= 画在血条下面），理由见 EntityHpBarConfig.lagNodeName 的注释。
     */
    private ensureLagNode(): void {
        const node = this.node;
        const parent = node?.parent;
        if (!node?.isValid || !parent?.isValid) {
            this.lagNode = null;
            this.lagTrans = null;
            return;
        }
        let lag = parent.getChildByName(HP_BAR.lagNodeName);
        if (!lag?.isValid) {
            const src = node.getComponent(Sprite);
            if (!src?.isValid) {
                this.lagNode = null;
                this.lagTrans = null;
                return;
            }
            lag = new Node(HP_BAR.lagNodeName);
            lag.layer = node.layer;
            parent.addChild(lag);
            lag.setSiblingIndex(node.getSiblingIndex());
            const sp = lag.addComponent(Sprite);
            sp.spriteFrame = src.spriteFrame;
            sp.type = src.type;
            sp.sizeMode = src.sizeMode;
            sp.color = this.lagPaint;
        }
        // UITransform 显式取（缺就补）：引擎里 `Sprite` 会通过 requireComponent 自动带上它，
        // 但**明确写上**才不依赖"组件依赖"这条隐式行为（也对体检脚本里那套极简桩友好）
        const trans = lag.getComponent(UITransform) ?? lag.addComponent(UITransform);
        // 与 hp_bar 同锚点、同位置 → 两条都从左缘往右长（血条预制件的锚点是 (0, 0.5)）
        trans.setAnchorPoint(0, 0.5);
        lag.setPosition(node.position.x, node.position.y, node.position.z);
        this.lagNode = lag;
        this.lagTrans = trans;
    }
}

/** 上浮缓动：起步快、末段慢（残影条"先收掉大半、再慢慢贴上"） */
function easeOutCubic(t: number): number {
    const v = t > 1 ? 1 : t < 0 ? 0 : t;
    const inv = 1 - v;
    return 1 - inv * inv * inv;
}
