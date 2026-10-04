import { _decorator, Color, Component, Graphics, Node, UITransform, view } from 'cc';
import { BattleEvents } from '../../battle';
import type { BattleContext } from '../../battle';
import { UnitKind } from '../../common/EntityVisualConfig';
import { HIT_FEEL_INFO, HIT_FEEL_MARK, clampBattleDt } from '../../common/HitFeelConfig';
import { HitFeelDirector } from './HitFeelDirector';
import { drawDigits, measureDigits } from './GeometricDigits';
const { ccclass } = _decorator;

/**
 * ============================================================
 * HitScreenLayer —— 屏幕层（打击反馈 B3「信息层」，整场战斗一个中央层）
 * ============================================================
 *
 * 设计文档：`docs/打击反馈设计.md` §7（B3）与 §10 的 F/C10 各项。数值真源：`HIT_FEEL_INFO`。
 *
 * ---- 它管哪四件事（都是"屏幕空间"的信息，不是战斗内容）----
 *   1. **F7 屏幕边缘受伤角标**：英雄受击时屏幕四角报红（**硬边直角标，不用渐变**）；
 *   2. **F4 连击计数**：连续击杀累计 + 一条"断连窗口"细条；
 *   3. **F8 击杀落款**：每次击杀在击杀点上方落一个短横 + 奖励数字，1.2s 淡出；
 *   4. **F9 金币 / 经验飞入**：奖励方块沿弧线飞向 HUD 上的金币 / 经验数字。
 *   另加 **C10 墨色闪帧**的**渲染**（α 由 `HitFeelDirector.flashAlpha` 出，本层只画）。
 *
 * ---- 为什么是独立一层，而不是塞进 HitVfxLayer ----
 *   `HitVfxLayer` 是**战斗内容层**，它跟着"内容层位移"一起抖（`applyBattleShake`）。
 *   屏幕层是**不抖**的：角标要贴着屏幕边缘、连击/落款要读得清、奖励要飞进**不抖的 HUD**。
 *   若把它们画在抖动的层里，震屏的 200~320ms 内整块 HUD 信息会跟着晃 —— 正是"信息"最不该晃的时候。
 *   所以本层**绝不参与位移**（不在 `Scene_Game_Stage.shakeTargets` 里）。
 *
 * ---- 坐标：与战斗内容层**同一个坐标系**，但落在 HUD 之下 ----
 *   预制件根下的所有层（`enimys` / `projectile*` / `vfx` / 本层 / `ctlrs_right`）都是**根的直接子节点**、
 *   局部变换都是 (0,0)/1 → 它们的局部空间**完全重合**。于是：
 *     · 击杀点（`entity.position`，逻辑坐标）**拿来即用**，不做任何转换；
 *     · HUD 上的落点则由场景用 `UITransform.convertToNodeSpaceAR` 算好递进来（见 `HitScreenOptions`）。
 *   本层节点插在 **HUD 之前**（= 画在 HUD 下面）：奖励飞过去时会"钻进"HUD 里消失，正是想要的读法。
 *
 * ---- 整层一个 Graphics = 恒定 1 draw call ----
 *   与 `DamageTextLayer` / `HitVfxLayer` 同一条约定：池化的是**数据对象**，画布只有一块。
 *   数字复用 `GeometricDigits`（工程里所有数字都是手写几何字形，零字体资产）。
 *
 * ---- 时间：走真实时间（同印痕层）----
 *   顿帧/慢动作缩的是**战斗时钟**，而屏幕信息不该跟着慢放（角标要立刻报、奖励要飞完）。
 *
 * ---- 击杀相关的一切都**由场景显式调用**（`killReward`），不订阅总线 ----
 *   原因：奖励金额是场景算出来的（`grantKillReward`：基础值 × 阶段系数 × 通胀 × 成就/遗物加成 × Boss 倍率），
 *   战斗总线的 `OnKill` 载荷只有 `{ killer, victim }` —— 表现层自己算会算出**另一个数**。
 *   所以"这一下拿了多少"由算数的那一方（场景）递进来，本层只负责画。
 *
 * 用法（Scene_Game_Stage）：
 *   `ensureHitScreenLayer()` 三级取用 + `bind(ctx, { rewardAnchor })`；
 *   每次击杀在 `grantKillReward` 里调 `killReward(dead.position.x, dead.position.y, gold, exp)`；
 *   换局 / 退出走 `unbind()`。
 */
@ccclass('HitScreenLayer')
export class HitScreenLayer extends Component {
    /** 全场共用的一块画布（整层恒定 1 draw call） */
    private g: Graphics | null = null;
    private ctx: BattleContext | null = null;
    private unsubs: (() => void)[] = [];
    /** 本层自己的时钟（只被 `update` 推进；不读 `Date.now()`，便于体检脚本用假时钟真跑） */
    private clock = 0;

    /** 视觉尺寸（设计分辨率的可见区，随机型变化）—— 角标贴边、连击贴左都要它 */
    private viewW = 0;
    private viewH = 0;

    /** F7：角标剩余时长（秒）；> 0 = 屏幕四角正在报红 */
    private hurtRemain = 0;

    /** F4：连击数 / 断连窗口剩余 / 淡出剩余 */
    private comboCount = 0;
    private comboRemain = 0;
    private comboFadeRemain = 0;

    /** F8 落款 / F9 奖励（数据对象池，节点一个都不建） */
    private tags: KillTag[] = [];
    private loots: LootItem[] = [];
    private freeTags: KillTag[] = [];
    private freeLoots: LootItem[] = [];

    /** 奖励落点提供者（场景注入；见 `HitScreenOptions.rewardAnchor`） */
    private anchor: (() => HitScreenAnchor | null) | null = null;

    /** 供 Graphics 复用的 Color 实例（setter 内部做拷贝，可以放心复用） */
    private readonly paint = new Color(255, 255, 255, 255);
    /** 上一帧是否真的画过：空场时省掉每帧 clear() */
    private drewLastFrame = false;

    /** 统计（调试面板 / `npm run audit:hitfeel` 读它） */
    readonly stats: HitScreenStats = {
        killTags: 0, loots: 0, lootsDropped: 0, combos: 0, peakCombo: 0, hurtMarks: 0, redraws: 0,
    };

    // ============ 对外只读面（调试 / 体检脚本用） ============

    /** 当前连击数 */
    get comboCountNow(): number {
        return this.comboCount;
    }

    /** 连击块此刻是否在显示（低于 `comboMinShow` 或已淡完 = false） */
    get comboShown(): boolean {
        return this.comboVisible();
    }

    /** 在场落款数 */
    get tagAlive(): number {
        return this.tags.length;
    }

    /** 在场奖励块数 */
    get lootAlive(): number {
        return this.loots.length;
    }

    /** 四角角标此刻是否在显示 */
    get hurtMarkShown(): boolean {
        return this.hurtRemain > 0;
    }

    // ============ 绑定 / 解绑 ============

    /**
     * 绑定战斗上下文
     *
     * @param ctx  战斗上下文（只用来取总线：本层只订阅"英雄受击"一条）
     * @param opts 可选的落点提供者（奖励飞入用）
     */
    bind(ctx: BattleContext, opts?: HitScreenOptions): void {
        this.unbind();

        this.g = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
        // 圆头 + 圆角拐角（风格预设：线宽 1.2~3px、圆头）
        this.g.lineJoin = Graphics.LineJoin.ROUND;
        this.g.lineCap = Graphics.LineCap.ROUND;

        // 撑满可见区：Graphics 自己画在哪由绘制坐标决定，但 UITransform 决定 UI 剔除框
        this.syncViewSize();
        const ui = this.node.getComponent(UITransform);
        if (ui) ui.setContentSize(this.viewW + 64, this.viewH + 64);

        this.anchor = opts?.rewardAnchor ?? null;
        this.ctx = ctx;
        if (ctx?.bus) {
            this.unsubs.push(ctx.bus.onBattleEvent(BattleEvents.OnTakeDamage, this.onTakeDamage, this));
        }
    }

    /**
     * 解绑 / 清场（换局 `resetRun`、退出战斗、重新 bind 都走它）。
     * 节点整棵被销毁走 `onDestroy`（那里不清画布，理由见 `DamageTextLayer.onDestroy`）。
     */
    unbind(): void {
        for (let i = 0; i < this.unsubs.length; i++) this.unsubs[i]();
        this.unsubs.length = 0;
        this.ctx = null;
        this.tags.length = 0;
        this.loots.length = 0;
        this.hurtRemain = 0;
        this.comboCount = 0;
        this.comboRemain = 0;
        this.comboFadeRemain = 0;
        this.clock = 0;
        if (this.g) this.g.clear();
        this.drewLastFrame = false;
    }

    /**
     * 组件销毁兜底：**只退订 + 断引用，不碰画布**（同 DamageTextLayer / HitVfxLayer：
     * `onDestroy` 里抛异常会堵死引擎的销毁队列 → 画面永久卡住）。
     */
    onDestroy(): void {
        for (let i = 0; i < this.unsubs.length; i++) this.unsubs[i]();
        this.unsubs.length = 0;
        this.ctx = null;
        this.anchor = null;
        this.tags.length = 0;
        this.loots.length = 0;
        this.freeTags.length = 0;
        this.freeLoots.length = 0;
        this.g = null;
    }

    // ============ 事件入口 ============

    /** 英雄受击（F7）：屏幕四角报红。**只认打在自己身上的那一下**（与 DamageTextLayer 同口径） */
    private onTakeDamage(e: any): void {
        if (e?.target?.unitKind !== UnitKind.Hero) return;
        this.hurtRemain = HIT_FEEL_INFO.hurtMarkMs / 1000;
        this.stats.hurtMarks++;
    }

    /**
     * 一次击杀的完整信息（F4 连击 + F8 落款 + F9 奖励飞入）—— **由场景在 `grantKillReward` 里调用**。
     *
     * @param x    击杀点 x（**逻辑坐标 == 本层局部坐标**，零转换）
     * @param y    击杀点 y
     * @param gold 本次实际到手金币（0 = 没有）
     * @param exp  本次实际到手经验（0 = 没有）
     */
    killReward(x: number, y: number, gold: number, exp: number): void {
        // 连击（F4）：窗口内（或正处在淡出宽限期）→ 累加；否则从 1 重新数。
        // ⚠ 窗口剩余量由 `update` 每帧推进（本方法可能在 `ctx.Tick` 中途被调），
        //   所以这里只读不推 —— 误差上限是一帧（16ms），对 2.5s 的窗口无意义。
        const alive = this.comboRemain > 0 || this.comboFadeRemain > 0;
        this.comboCount = alive ? this.comboCount + 1 : 1;
        this.comboRemain = HIT_FEEL_INFO.comboWindowSec;
        this.comboFadeRemain = 0;
        this.stats.combos++;
        if (this.comboCount > this.stats.peakCombo) this.stats.peakCombo = this.comboCount;

        const amount = gold > 0 ? gold : exp;
        if (amount > 0) this.spawnTag(x, y, amount);

        const anchor = this.anchor ? this.anchor() : null;
        if (gold > 0) this.spawnLoot(x, y, anchor?.gold ?? null, LootKind.Gold);
        if (exp > 0) this.spawnLoot(x, y, anchor?.exp ?? null, LootKind.Exp);
    }

    // ============ 生成 ============

    /** 落一个击杀落款（短横 + 奖励数字） */
    private spawnTag(x: number, y: number, amount: number): void {
        const it = this.freeTags.pop() ?? ({} as KillTag);
        it.x = x;
        it.y = y;
        it.amount = amount;
        it.age = 0;
        it.life = HIT_FEEL_INFO.killTagMs / 1000;
        this.tags.push(it);
        this.stats.killTags++;
    }

    /**
     * 飞出一块奖励（F9）
     *
     * @param target 落点（**本层局部坐标**，由场景从 HUD 上算出来）；null = 没有 HUD 锚点 →
     *               退化成"朝右上飞一小段"（**绝不静默不画**：宁可不精确，也要有反馈）
     */
    private spawnLoot(x: number, y: number, target: { x: number; y: number } | null, kind: LootKind): void {
        // 并发上限：超限淘汰最老的（奖励是"数值增长"的宣告，迟到就没有意义了）
        while (this.loots.length >= HIT_FEEL_INFO.lootAliveMax) {
            let worstIdx = -1;
            let worstAge = -1;
            for (let i = 0; i < this.loots.length; i++) {
                if (this.loots[i].age > worstAge) {
                    worstAge = this.loots[i].age;
                    worstIdx = i;
                }
            }
            if (worstIdx < 0) break;
            this.recycleLoot(this.loots[worstIdx]);
            this.loots.splice(worstIdx, 1);
            this.stats.lootsDropped++;
        }

        const it = this.freeLoots.pop() ?? ({} as LootItem);
        it.x0 = x;
        it.y0 = y;
        if (target) {
            it.tx = target.x;
            it.ty = target.y;
        } else {
            it.tx = x + HIT_FEEL_INFO.lootFallbackPx * 0.7;
            it.ty = y + HIT_FEEL_INFO.lootFallbackPx;
        }
        // 控制点：中点 + 垂线拱起（直线飞太"机械"；拱的方向按起终点连线的法线取）
        const dx = it.tx - it.x0;
        const dy = it.ty - it.y0;
        const len = Math.sqrt(dx * dx + dy * dy);
        const nx = len > 0 ? -dy / len : 0.7071;
        const ny = len > 0 ? dx / len : 0.7071;
        it.cx = (it.x0 + it.tx) * 0.5 + nx * HIT_FEEL_INFO.lootArcPx;
        it.cy = (it.y0 + it.ty) * 0.5 + ny * HIT_FEEL_INFO.lootArcPx;
        it.kind = kind;
        it.age = 0;
        it.life = HIT_FEEL_INFO.lootMs / 1000;
        this.loots.push(it);
        this.stats.loots++;
    }

    private recycleTag(it: KillTag): void {
        if (this.freeTags.length < 64) this.freeTags.push(it);
    }

    private recycleLoot(it: LootItem): void {
        if (this.freeLoots.length < HIT_FEEL_INFO.lootAliveMax * 2) this.freeLoots.push(it);
    }

    // ============ 每帧：推进 + 整层重绘 ============

    update(dt: number): void {
        const g = this.g;
        if (!g) return;

        const d = clampBattleDt(dt);
        this.clock += d;
        this.syncViewSize();

        // 推进（倒序遍历，边删边退）
        this.tickHurt(d);
        this.tickCombo(d);
        for (let i = this.tags.length - 1; i >= 0; i--) {
            const it = this.tags[i];
            it.age += d;
            if (it.age >= it.life) {
                this.recycleTag(it);
                this.tags.splice(i, 1);
            }
        }
        for (let i = this.loots.length - 1; i >= 0; i--) {
            const it = this.loots[i];
            it.age += d;
            if (it.age >= it.life) {
                this.recycleLoot(it);
                this.loots.splice(i, 1);
            }
        }

        // 墨色闪帧（C10）：**α 由导演出**（它管冷却与预算），本层只画
        const flash = HitFeelDirector.active?.flashAlpha ?? 0;

        // 空场剪枝（省掉每帧 clear）
        const empty = flash <= 0 && this.hurtRemain <= 0 && !this.comboVisible()
            && this.tags.length === 0 && this.loots.length === 0;
        if (empty && !this.drewLastFrame) return;

        g.clear();
        // 顺序 = 从"底"到"面"：墨闪压在最底（不遮住它上面的信息），奖励在最上
        if (flash > 0) this.drawFlash(g, flash);
        if (this.hurtRemain > 0) this.drawHurtMarks(g);
        if (this.comboVisible()) this.drawCombo(g);
        for (let i = 0; i < this.tags.length; i++) this.drawTag(g, this.tags[i]);
        for (let i = 0; i < this.loots.length; i++) this.drawLoot(g, this.loots[i]);

        this.drewLastFrame = !empty;
        this.stats.redraws++;
    }

    // ============ 推进 ============

    private tickHurt(d: number): void {
        if (this.hurtRemain <= 0) return;
        this.hurtRemain -= d;
        if (this.hurtRemain < 0) this.hurtRemain = 0;
    }

    /**
     * 连击窗口（F4）
     *
     * 窗口内 → 计数保持（细条随窗口缩短）；窗口过期 → 进入淡出段（**不是"啪"地消失**，
     * 那样会把"我断连了"这件事放大成一次视觉事故），淡完才把计数清零。
     */
    private tickCombo(d: number): void {
        if (this.comboCount <= 0 || d <= 0) return;
        if (this.comboRemain > 0) {
            this.comboRemain -= d;
            if (this.comboRemain > 0) return;
            this.comboRemain = 0;
            this.comboFadeRemain = HIT_FEEL_INFO.comboFadeMs / 1000;
            return;
        }
        if (this.comboFadeRemain <= 0) {
            this.comboCount = 0;
            return;
        }
        this.comboFadeRemain -= d;
        if (this.comboFadeRemain <= 0) {
            this.comboFadeRemain = 0;
            this.comboCount = 0;
        }
    }

    // ============ 绘制 ============

    /**
     * C10 墨色闪帧：整屏盖一层墨（**浅底上只有墨色能用，白闪看不见**）
     *
     * 画成"比可见区再大一圈"的实心矩形：`Graphics` 没有"屏幕矩形"这个概念，
     * 而 UI 剔除是按本节点 UITransform 的矩形来的（bind 时已撑到可见区 + 64）。
     */
    private drawFlash(g: Graphics, alpha: number): void {
        const halfW = this.viewW * 0.5 + 4;
        const halfH = this.viewH * 0.5 + 4;
        this.setPaint(g, HIT_FEEL_MARK.ink, alpha);
        g.rect(-halfW, -halfH, halfW * 2, halfH * 2);
        g.fill();
    }

    /**
     * F7 屏幕边缘受伤角标：四角各一个**硬边直角标**（两条正交短线）
     *
     * ① **硬边、不用渐变**：风格预设把渐变列进禁用清单，而且"四角渐晕"在浅底上会糊成一片灰；
     * ② 颜色用 `c-danger #C0392B`（风格预设 §9-3 的建议值，且规定"只用于文字与细线"），
     *    **不用** `#FF4C4C` —— 那个是"单位受击色"（= 打谁），搬到整屏边框上会变成第四种强调色；
     * ③ 每角两条臂只 stroke 一次（与刻度同一套画法）。
     */
    private drawHurtMarks(g: Graphics): void {
        const total = HIT_FEEL_INFO.hurtMarkMs / 1000;
        const alpha = HIT_FEEL_INFO.hurtMarkAlpha * (total > 0 ? this.hurtRemain / total : 0);
        if (alpha <= 0) return;
        const halfW = this.viewW * 0.5;
        const halfH = this.viewH * 0.5;
        const x = halfW - HIT_FEEL_INFO.hurtMarkInset;
        const y = halfH - HIT_FEEL_INFO.hurtMarkInset;
        const arm = HIT_FEEL_INFO.hurtMarkArm;
        this.setPaint(g, HIT_FEEL_INFO.hurtMarkColor, alpha);
        g.lineWidth = HIT_FEEL_INFO.hurtMarkWidth;
        // 四个角：每个角都从角点朝内画两条臂（右上 / 左上 / 左下 / 右下）
        for (let i = 0; i < 4; i++) {
            const sx = i === 0 || i === 3 ? 1 : -1;
            const sy = i < 2 ? 1 : -1;
            const cx = sx * x;
            const cy = sy * y;
            g.moveTo(cx, cy);
            g.lineTo(cx - sx * arm, cy);
            g.moveTo(cx, cy);
            g.lineTo(cx, cy - sy * arm);
        }
        g.stroke();
    }

    /**
     * F4 连击计数：左边一个"×N" + 一条"断连窗口"细条
     *
     * 数字复用 `GeometricDigits`（工程里所有数字都是手写几何字形，字体资产为零）；
     * 那个 `×` 是自己画的两条短线 —— 字形表里只有 0~9，非数字字符会被跳过（但会占位留白，
     * 直接用 `'×' + n` 会留下一个空洞）。
     */
    private drawCombo(g: Graphics): void {
        const size = HIT_FEEL_INFO.comboFontSize;
        const alpha = this.comboAlpha();
        if (alpha <= 0) return;
        const left = -this.viewW * 0.5 + HIT_FEEL_INFO.comboInsetX;
        const cy = HIT_FEEL_INFO.comboOffsetY;
        const text = String(this.comboCount);
        const crossW = size * 0.42;
        const gap = size * 0.22;
        const digitsW = measureDigits(text, size);
        const totalW = crossW + gap + digitsW;

        // × 号（左端）
        this.setPaint(g, HIT_FEEL_MARK.ink, alpha);
        g.lineWidth = Math.max(1.4, size * 0.09);
        const cxc = left + crossW * 0.5;
        const arm = crossW * 0.5;
        g.moveTo(cxc - arm, cy - arm);
        g.lineTo(cxc + arm, cy + arm);
        g.moveTo(cxc - arm, cy + arm);
        g.lineTo(cxc + arm, cy - arm);
        g.stroke();

        // 数字（基线 = 视觉中心 - 半字高，字形框是 [0,1]×size）
        this.setPaint(g, HIT_FEEL_MARK.ink, alpha);
        g.lineWidth = Math.max(1, size * 0.085);
        drawDigits(g, text, left + crossW + gap + digitsW * 0.5, cy - size * 0.5, size);

        // 断连窗口细条（长度 = 剩余窗口比例）—— 断连前会看到它"烧完"
        const ratio = HIT_FEEL_INFO.comboWindowSec > 0
            ? Math.max(0, Math.min(1, this.comboRemain / HIT_FEEL_INFO.comboWindowSec))
            : 0;
        const barY = cy - size * 0.5 - size * 0.42;
        this.setPaint(g, HIT_FEEL_MARK.inkSoft, alpha * 0.7);
        g.rect(left, barY, HIT_FEEL_INFO.comboBarWidth, HIT_FEEL_INFO.comboBarHeight);
        g.fill();
        if (ratio > 0) {
            this.setPaint(g, HIT_FEEL_MARK.ink, alpha);
            g.rect(left, barY, HIT_FEEL_INFO.comboBarWidth * ratio, HIT_FEEL_INFO.comboBarHeight);
            g.fill();
        }
    }

    private comboAlpha(): number {
        if (this.comboFadeRemain > 0) {
            const fadeSec = HIT_FEEL_INFO.comboFadeMs / 1000;
            return fadeSec > 0 ? this.comboFadeRemain / fadeSec : 0;
        }
        return this.comboRemain > 0 ? 1 : 0;
    }

    /** 连击块当前是否可见（低于 `comboMinShow` 不显示 —— 1 连击没有任何信息量） */
    private comboVisible(): boolean {
        return this.comboCount >= HIT_FEEL_INFO.comboMinShow && this.comboAlpha() > 0;
    }

    /** F8 击杀落款：奖励数字 + 下面一道短横（制图里的"落款线"），整体上浮并淡出 */
    private drawTag(g: Graphics, it: KillTag): void {
        const t = it.life > 0 ? it.age / it.life : 1;
        if (t >= 1) return;
        const rise = HIT_FEEL_INFO.killTagRisePx * easeOutCubic(t);
        const alpha = 1 - t * t;
        const size = HIT_FEEL_INFO.killTagFontSize;
        const cx = it.x;
        const cy = it.y + rise;

        this.setPaint(g, HIT_FEEL_MARK.ink, alpha);
        g.lineWidth = HIT_FEEL_INFO.killTagLineWidth;
        const halfLen = HIT_FEEL_INFO.killTagLineLen * 0.5;
        g.moveTo(cx - halfLen, cy - size * 0.9);
        g.lineTo(cx + halfLen, cy - size * 0.9);
        g.stroke();

        this.setPaint(g, HIT_FEEL_MARK.ink, alpha);
        g.lineWidth = Math.max(1, size * 0.1);
        drawDigits(g, String(it.amount), cx, cy - size * 0.5, size);
    }

    /**
     * F9 奖励飞入：沿**二次贝塞尔**弧线飞向落点，末段淡出
     *
     * 金币 = 实心方块，经验 = 空心方块（形状承载"是哪种奖励"，颜色通道不参与 —— 与口径 4 一致）。
     */
    private drawLoot(g: Graphics, it: LootItem): void {
        const t = it.life > 0 ? it.age / it.life : 1;
        if (t >= 1) return;
        // 先快后慢地飞（ease-out）：出手迅速、落在 HUD 上时几乎停住
        const k = easeOutCubic(t);
        const inv = 1 - k;
        const x = inv * inv * it.x0 + 2 * inv * k * it.cx + k * k * it.tx;
        const y = inv * inv * it.y0 + 2 * inv * k * it.cy + k * k * it.ty;
        const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        const size = HIT_FEEL_INFO.lootSize;
        const half = size * 0.5;
        if (it.kind === LootKind.Gold) {
            this.setPaint(g, HIT_FEEL_MARK.ink, alpha);
            g.rect(x - half, y - half, size, size);
            g.fill();
        } else {
            this.setPaint(g, HIT_FEEL_MARK.ink, alpha);
            g.lineWidth = 1.6;
            g.rect(x - half, y - half, size, size);
            g.stroke();
        }
    }

    // ============ 工具 ============

    /** 取可见区尺寸（每帧最多一次；机型/窗口变了立刻跟上） */
    private syncViewSize(): void {
        const size = view.getVisibleSize();
        if (size.width > 0) this.viewW = size.width;
        if (size.height > 0) this.viewH = size.height;
    }

    /**
     * 设置当前画笔色（描边 + 填充同时设）
     *
     * Graphics 的 strokeColor/fillColor 是**在 stroke()/fill() 调用时**才被读走并烘进顶点色的，
     * 所以这里复用一个 Color 实例是安全的，不会串色。
     */
    private setPaint(g: Graphics, rgb: number, alpha: number): void {
        const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
        this.paint.set((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, Math.round(a * 255));
        g.strokeColor = this.paint;
        g.fillColor = this.paint;
    }
}

// ============ 对外接口 ============

/** 奖励飞入的落点（**本层局部坐标**） */
export interface HitScreenAnchor {
    /** 金币数字在屏幕上的位置 */
    gold: { x: number; y: number } | null;
    /** 经验数字在屏幕上的位置 */
    exp: { x: number; y: number } | null;
}

export interface HitScreenOptions {
    /**
     * 奖励落点提供者（场景注入）
     *
     * **每次击杀现算、不缓存**：HUD 上的位置由 Widget 布局决定，缓存下来会在换分辨率 / 转屏 /
     * 改布局之后指到错的地方（而"飞错地方"比"不飞"更糟）。返回 null = 没有 HUD → 退化飞行。
     */
    rewardAnchor?: () => HitScreenAnchor | null;
}

/** 屏幕层统计（调试面板 / 体检脚本读它） */
export interface HitScreenStats {
    /** 落款次数（= 有奖励的击杀次数） */
    killTags: number;
    /** 飞出的奖励块数 */
    loots: number;
    /** 因并发上限被淘汰的奖励块数 */
    lootsDropped: number;
    /** 累计击杀（连击的分子） */
    combos: number;
    /** 连击峰值 */
    peakCombo: number;
    /** 屏幕边缘角标触发次数（= 英雄受击次数） */
    hurtMarks: number;
    /** 真正重绘过的帧数（空场不重绘） */
    redraws: number;
}

// ============ 数据类型（池化复用，不持有节点） ============

/** 击杀落款 */
interface KillTag {
    x: number;
    y: number;
    /** 奖励数字（金币优先，没有金币就用经验） */
    amount: number;
    age: number;
    life: number;
}

enum LootKind {
    Gold = 0,
    Exp = 1,
}

/** 奖励方块（位置由二次贝塞尔闭式解算，所以存的是起终点与控制点） */
interface LootItem {
    x0: number;
    y0: number;
    cx: number;
    cy: number;
    tx: number;
    ty: number;
    kind: LootKind;
    age: number;
    life: number;
}

/** 上浮缓动：起步快、末段慢 */
function easeOutCubic(t: number): number {
    const v = t > 1 ? 1 : t < 0 ? 0 : t;
    const inv = 1 - v;
    return 1 - inv * inv * inv;
}
