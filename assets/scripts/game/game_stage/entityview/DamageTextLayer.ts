import { _decorator, Color, Component, Graphics, Node, UITransform } from 'cc';
import { BattleContext, BattleEvents } from '../../battle';
import { UnitKind } from '../../common/EntityVisualConfig';
import { DAMAGE_TEXT, DamageTextTier, getDamageTextStyle } from '../../common/DamageTextConfig';
import { drawDigits, fillDiamond, measureDigits } from './GeometricDigits';
const { ccclass } = _decorator;

/** 本层 UITransform 的覆盖尺寸（战场以原点为中心、刷怪半径 ≤ 800，取 4000 留足余量） */
const COVER_SIZE = 4000;

/**
 * ============================================================
 * DamageTextLayer —— 飘伤害字（表现层，整场战斗一个中央层）
 * ============================================================
 *
 * 与 EntityView 的受击闪烁**分工**（同一个 OnTakeDamage 事件驱动，互不干扰）：
 *   · HitFlash 负责"瞬时命中感"（0.08s 染色，见 HitFlash）
 *   · 本层负责"结果"（掉了多少血、有没有暴击）
 *
 * ---- 为什么是"中央层"而不是"每个实体一个飘字组件" ----
 *   1. **订阅一次 vs 订阅 N 次**：EntityView 是每个视图各订阅一次总线、再按 target 过滤
 *      （O(N) × 每次伤害）。飘字是纯展示、与实体视图生命周期无关（怪死了数字也该飘完），
 *      所以整层只订阅一次，事件来了按 target 拿快照就完事。
 *   2. **全局规则**：合并窗口、并发上限、优先级淘汰、连击阶梯都是"全场"口径，
 *      只有中央层放得下这些状态。
 *   3. **恒定 1 次 draw call**：所有飘字画在**同一个 Graphics** 上（不是每个数字一个 Label 节点）。
 *      Label / LabelAtlas 都是一个组件一次 draw call，24 个飘字就是 24 次；
 *      这里整层恒定 1 次，而且池化的是**纯数据对象**（连节点都不用建）。
 *
 * ---- 反噪声（塔防必须，自动攻击 + 几十只怪 + DoT 会瞬间糊屏）----
 *   · **合并**：同目标 + 同档位 + 同来源，0.15s 窗口内累加成一个数字（见 DAMAGE_TEXT.mergeWindow）；
 *     对**英雄**的伤害不分来源、一律合并 —— 读作"这一下我总共挨了多少"，而不是"被几只怪各咬了一口"。
 *   · **并发上限**：全场同时最多 DAMAGE_TEXT.maxAlive 个，超出先淘汰优先级最低的（暴击 > 普通，
 *     英雄受击优先级 +6 → 自己掉血永远不会被怪的数字挤掉）。
 *   · **连击阶梯**：同一目标连续跳字沿 y 错开（单发永远从基准高度起，连击才铺开），不会叠成一坨。
 *   · **横向抖散**：按 target.uid 稳定散开，AoE 打一片时不重叠；英雄受击不抖（保持居中好读）。
 *
 * ---- 位置快照（重要）----
 *   DamagePipeline 的 publish(OnTakeDamage) 发生在 ChangeHp 之后、Die 之前，
 *   而实体死亡后 EntityView.update 就不再同步位置了 —— 所以必须在**事件回调里立刻**
 *   读一次 target.position 存下来，之后再读就是过时值。
 *
 * ---- 坐标系（零转换，靠"同一坐标系"这个契约保证）----
 *   EntityView.bind 是直接 node.setPosition(entity.position)，即 **monsterParent 的局部空间
 *   == 逻辑世界坐标**。飘字层节点与 monsterParent 处在**同一坐标系**下：
 *   预制件里 `damege_layer` 与 `enimys` 同为场景根的子节点、两者 _lpos 都是 (0,0)、缩放都是 1，
 *   两个节点的局部空间完全重合 —— 所以 entity.position **拿来即用，不做任何坐标转换**
 *   （坐标换算的代码已经删掉：在当前摆法下 `inv(本层世界矩阵) × 参照世界矩阵 ≡ 单位矩阵`，
 *   留着只是白算，还多一层"世界矩阵何时就绪"的依赖）。
 *
 *   契约（**改层级时必须遵守**）：飘字层与 monsterParent 必须同坐标系，等价说法是
 *   "层节点挂在 monsterParent 下、或与它同父同变换"。bind 时会做一次自检（见 checkSpace），
 *   把层节点在同一父节点下挪了位置/改了缩放这种"必定画错"的情况打成警告。
 *
 * 用法（Scene_Game_Stage）：
 *   ① 编辑器摆好：节点（layer 必须是 UI_2D、与 enimys 同坐标系）挂上本组件 → 拖进 damageLayerNode；
 *   ② 运行时兜底：没有引用也没有组件时，自动建一个节点挂在 monsterParent 最后（压在怪物之上）。
 *   两条路都走 `bind(ctx, monsterParent)`：第二个参数是**逻辑坐标的参照节点**（自检用）。
 */
@ccclass('DamageTextLayer')
export class DamageTextLayer extends Component {
    /** 全场共用的一块画布：所有飘字都画在它上面（1 次 draw call） */
    private g: Graphics | null = null;

    /** 战斗上下文（只用来取总线；解绑时置空） */
    private ctx: BattleContext | null = null;
    /** 伤害事件退订句柄（解绑/回收必须调用） */
    private unsub: (() => void) | null = null;

    /** 在场飘字（顺序 = 出生顺序） */
    private items: DamageTextItem[] = [];
    /** 数据对象池（注意：池化的是数据，不是节点 —— 整层只有一个 Graphics） */
    private free: DamageTextItem[] = [];
    /** 供 Graphics.strokeColor 复用的 Color 实例（strokeColor setter 内部做拷贝，可以放心复用） */
    private readonly paint = new Color(255, 255, 255, 255);
    /** 上一帧是否真的画过：空场时省掉每帧 clear() */
    private drewLastFrame = false;

    /**
     * 逻辑坐标的参照节点（= monsterParent）
     *
     * 只用于 bind 时的一次坐标系自检（见 checkSpace）——飘字是**按逻辑坐标直接绘制**的，
     * 不做坐标转换，前提是本层节点与它同坐标系（见类注释的坐标系契约）。
     */
    private spaceAnchor: Node | null = null;

    // ============ 绑定 / 解绑 ============

    /**
     * 绑定战斗上下文：取画布 + 订阅伤害总线（整层只订阅一次）
     *
     * @param ctx         战斗上下文（只用来取总线）
     * @param spaceAnchor **逻辑坐标的参照节点**（= monsterParent）。只用于坐标系自检：
     *                    飘字不做坐标转换，靠"层节点与它同坐标系"这个契约保证位置正确。
     */
    bind(ctx: BattleContext, spaceAnchor?: Node): void {
        this.unbind();

        this.g = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
        // 直角拐角（数字的拐角就是直角）+ 平切端头（笔画端点与字框对齐，不外溢）
        this.g.lineJoin = Graphics.LineJoin.MITER;
        this.g.lineCap = Graphics.LineCap.BUTT;

        // UITransform 只影响布局/裁剪框，不影响 Graphics 自己画在哪 ——
        // 但把它撑到覆盖整个战场（战场以原点为中心、刷怪半径 ≤ 800），
        // 可以避免"UI 渲染按节点矩形剔除"把远处飘字剔掉；本层节点永远不动，不需要跟随。
        const ui = this.node.getComponent(UITransform);
        if (ui) ui.setContentSize(COVER_SIZE, COVER_SIZE);

        this.spaceAnchor = spaceAnchor ?? this.node.parent;
        this.checkSpace(this.spaceAnchor);

        this.ctx = ctx;
        if (ctx?.bus) {
            this.unsub = ctx.bus.onBattleEvent(BattleEvents.OnTakeDamage, this.onTakeDamage, this);
        }
    }

    /**
     * 坐标系自检（bind 时一次；纯局部变换比较，不依赖世界矩阵，所以不会有"矩阵还没就绪"的误报）
     *
     * 能零成本且**必定正确**地判出来的错法只有一种：层节点就在参照节点的同一父节点下、
     * 但被挪了位置或改了缩放 —— 这时两个局部空间差一个位移/缩放，飘字会整体偏掉（字号也会不对），
     * 所以打一条警告。其余层级关系（挂到别的父节点下）没法廉价校验，见类注释的坐标系契约。
     */
    private checkSpace(anchor: Node | null): void {
        if (!anchor?.isValid || this.node.parent !== anchor) return;
        const p = this.node.position;
        const s = this.node.scale;
        if (p.x === 0 && p.y === 0 && s.x === 1 && s.y === 1) return;
        console.warn(
            `[DamageTextLayer] 飘字层与 ${anchor.name} 同父但局部变换不同`
            + `（position=${p.x},${p.y} scale=${s.x},${s.y}）：飘字按逻辑坐标直接绘制、不做坐标转换，`
            + '位置会整体偏移 —— 请把层节点的 position 归零、scale 置 1，或让它与参照节点保持同一变换。',
        );
    }

    /**
     * 解绑 / 清场：退订 + 回收全部飘字 + 清画布。
     * 用在**节点还活着**的时候（换局 `resetRun`、重新 bind、回收复用）；节点整棵被销毁走 `onDestroy`（那里不清画布）。
     */
    unbind(): void {
        if (this.unsub) {
            this.unsub();
            this.unsub = null;
        }
        this.ctx = null;
        for (let i = 0; i < this.items.length; i++) this.recycle(this.items[i]);
        this.items.length = 0;
        if (this.g) this.g.clear();
        this.drewLastFrame = false;
    }

    /**
     * 组件销毁兜底：**只退订 + 断引用，不碰画布**（不要在这里调 `unbind()`）。
     *
     * 画布（Graphics）与本组件同节点，销毁顺序由组件注册顺序决定 —— 画布可能已经先被销毁，
     * Cocos 的 `_destruct()` 会把它的对象字段置 null（`Graphics._impl` → null），
     * 此时 `this.g.clear()` 会抛 TypeError。而 `onDestroy` 是引擎 `CCObject._deferredDestroy()` 调的：
     * 那里抛异常会让销毁队列**不清空**（下一帧从同一个对象重新抛），并且 `director.tick` 会在
     * 绘制/提交渲染之前被打断 → **画面永久卡在上一帧**（详见 EntityView.onDestroy 的同类说明）。
     * 节点整棵都在销毁，清画布/回收飘字都没有意义；换局复用（节点不销毁）走 `unbind()`。
     */
    onDestroy(): void {
        if (this.unsub) {
            this.unsub();
            this.unsub = null;
        }
        this.ctx = null;
        this.spaceAnchor = null;
        this.items.length = 0;
        this.free.length = 0;
        this.g = null;
    }

    /** 当前在场飘字数（调试 / 自检用） */
    get aliveCount(): number {
        return this.items.length;
    }

    // ============ 事件入口 ============

    /** 战斗总线 OnTakeDamage：整层唯一的伤害入口 */
    private onTakeDamage(e: any): void {
        const target = e?.target;
        if (!target || !target.position) return;

        // 整数化口径：DamagePipeline 的 finalDamage 是浮点，飘字只显示整数、且不允许出现 0
        const value = Math.max(1, Math.round(e.finalDamage ?? 0));
        if (value <= 0) return;

        // 位置快照：必须在这里取（事件之后实体可能已被回收，位置不再同步）
        const px = target.position.x;
        const py = target.position.y;

        const heroHurt = target.unitKind === UnitKind.Hero;
        const tier = e.isCrit ? DamageTextTier.Crit : DamageTextTier.Normal;
        const sourceUid = e.source?.uid ?? -1;

        if (this.mergeInto(target.uid, heroHurt, tier, sourceUid, value)) return;
        this.spawn(target.uid, heroHurt, tier, sourceUid, px, py, value);
    }

    // ============ 合并 / 生成 / 淘汰 ============

    /**
     * 尝试合并进已有飘字（同目标 + 同档位 + 同来源，且还在合并窗口内）
     *
     * 合并后数字**从它当前所在的位置继续往上飘**（而不是跳回出生点），读起来就是
     * "这个数字又涨了"，不会闪一下。
     *
     * @returns 是否已合并（false = 需要新建）
     */
    private mergeInto(
        targetUid: number,
        heroHurt: boolean,
        tier: DamageTextTier,
        sourceUid: number,
        value: number,
    ): boolean {
        for (let i = 0; i < this.items.length; i++) {
            const it = this.items[i];
            if (it.targetUid !== targetUid) continue;
            if (it.tier !== tier) continue;
            if (it.age >= DAMAGE_TEXT.mergeWindow) continue;
            // 英雄受击不分来源（读作"这一下总共挨了多少"）；怪物受击按来源分开（各算各的）
            if (!heroHurt && it.sourceUid !== sourceUid) continue;

            const st = getDamageTextStyle(it.tier);
            const t = clamp01(it.age / it.life);
            it.value += value;
            it.x0 = it.x0 + it.offsetX; // 当前位置（含抖散）作为新的起点
            it.y0 = it.y0 + st.rise * easeOutCubic(t);
            it.offsetX = 0;
            it.age = 0;
            return true;
        }
        return false;
    }

    /** 生成一个新飘字（先按并发上限淘汰，再决定纵向阶梯层与横向抖散） */
    private spawn(
        targetUid: number,
        heroHurt: boolean,
        tier: DamageTextTier,
        sourceUid: number,
        px: number,
        py: number,
        value: number,
    ): void {
        this.evictIfFull();

        // 同一目标当前在场的数量 → 阶梯层（单发永远是第 0 层，只有在连击时才往上铺）
        let liveOnTarget = 0;
        for (let i = 0; i < this.items.length; i++) {
            if (this.items[i].targetUid === targetUid) liveOnTarget++;
        }
        const step = liveOnTarget % DAMAGE_TEXT.ladderSteps;

        const it = this.free.pop() ?? ({} as DamageTextItem);
        const st = getDamageTextStyle(tier);
        it.value = value;
        it.tier = tier;
        it.heroHurt = heroHurt;
        it.targetUid = targetUid;
        it.sourceUid = sourceUid;
        // 英雄受击居中对齐（好读），其余按 uid 稳定抖散（AoE 打一片时不重叠）
        it.offsetX = heroHurt ? 0 : stableScatter(targetUid);
        it.x0 = px;
        it.y0 = py + DAMAGE_TEXT.spawnOffsetY + step * DAMAGE_TEXT.baseFontSize * DAMAGE_TEXT.ladderGapRatio;
        it.age = 0;
        it.life = st.life;
        // 英雄受击优先级加成：自己的血条比怪的数字重要得多
        it.priority = st.priority + (heroHurt ? 6 : 0);

        this.items.push(it);
    }

    /** 并发上限：超了就淘汰"优先级最低、同优先级里最老"的那个 */
    private evictIfFull(): void {
        while (this.items.length >= DAMAGE_TEXT.maxAlive) {
            let worstIdx = -1;
            let worstScore = Infinity;
            for (let i = 0; i < this.items.length; i++) {
                const it = this.items[i];
                // 优先级权重远大于年龄：先比优先级，再比谁更老
                const score = it.priority * 1000 + it.age;
                if (score < worstScore) {
                    worstScore = score;
                    worstIdx = i;
                }
            }
            if (worstIdx < 0) return;
            this.recycle(this.items[worstIdx]);
            this.items.splice(worstIdx, 1);
        }
    }

    /** 回收一个飘字（只回数据对象池） */
    private recycle(it: DamageTextItem): void {
        if (this.free.length < DAMAGE_TEXT.maxAlive * 2) this.free.push(it);
    }

    // ============ 每帧：推进 + 整层重绘 ============

    update(dt: number): void {
        const g = this.g;
        if (!g) return;

        // 1) 推进寿命、回收到期（倒序遍历，边删边退）
        for (let i = this.items.length - 1; i >= 0; i--) {
            const it = this.items[i];
            it.age += dt;
            if (it.age >= it.life) {
                this.recycle(it);
                this.items.splice(i, 1);
            }
        }

        // 2) 空场且上帧也没画过 → 省掉 clear()
        if (this.items.length === 0 && !this.drewLastFrame) return;

        // 3) 整层重绘（clear 一次 + 每个数字一次 stroke，全程 1 次 draw call）
        g.clear();
        // 先画普通、再画暴击 → 暴击永远压在最上层（后画的盖前面的）
        for (let i = 0; i < this.items.length; i++) {
            if (this.items[i].tier !== DamageTextTier.Crit) this.drawItem(g, this.items[i]);
        }
        for (let i = 0; i < this.items.length; i++) {
            if (this.items[i].tier === DamageTextTier.Crit) this.drawItem(g, this.items[i]);
        }
        this.drewLastFrame = this.items.length > 0;
    }

    /** 画一个飘字（位置 / 缩放 / 淡出全部由寿命 age 推出来，无 tween、无定时器） */
    private drawItem(g: Graphics, it: DamageTextItem): void {
        const st = getDamageTextStyle(it.tier);
        const t = clamp01(it.age / it.life);
        const size = this.sizeOf(it, st);
        const alpha = alphaOf(t, st.fadeFrom);
        const rgb = it.heroHurt ? st.heroColor : st.color;

        // 逻辑坐标 == 本层局部坐标（同一坐标系，零转换，见类注释）
        const x = it.x0 + it.offsetX;
        const baseline = it.y0 + st.rise * easeOutCubic(t);
        const text = String(it.value);

        // 几何先算好：暴击的左侧菱形标与数字**作为一组整体居中**（数字右移一点）
        let badgeCx = 0;
        let badgeW = 0;
        let badgeH = 0;
        let textX = x;
        if (st.marker > 0) {
            badgeW = size * st.marker;
            badgeH = size * st.markerHeight;
            const gap = size * st.markerGap;
            const width = measureDigits(text, size);
            const left = x - (badgeW * 2 + gap + width) * 0.5;
            badgeCx = left + badgeW;
            textX = left + badgeW * 2 + gap + width * 0.5;
        }
        const textCy = baseline + size * 0.5;

        const strokeW = Math.max(1, size * DAMAGE_TEXT.strokeRatio);
        const grows = DAMAGE_TEXT.outlineGrow > 0;
        const outlineW = strokeW + size * DAMAGE_TEXT.outlineGrow;
        // 实心菱形要外扩半个"溢出量"，才能和文字的描边厚度看起来一致
        const outlineHalf = (size * DAMAGE_TEXT.outlineGrow) * 0.5;

        // ---- 第一遍：描边（暗色、更粗，全部压在彩色之前）----
        // 战斗背景是浅色，而普通伤害字是白的 —— 没有这层暗边就是白底白字。
        // 白字 + 深边的好处是**浅底和深底上都能读**，颜色不用为背景分两套。
        if (grows) {
            this.setPaint(g, DAMAGE_TEXT.outlineColor, alpha);
            g.lineWidth = outlineW;
            if (badgeW > 0) {
                fillDiamond(g, badgeCx, textCy, badgeW + outlineHalf, badgeH + outlineHalf);
            }
            drawDigits(g, text, textX, baseline, size);
        }

        // ---- 第二遍：正文（彩色）----
        this.setPaint(g, rgb, alpha);
        g.lineWidth = strokeW;
        if (badgeW > 0) fillDiamond(g, badgeCx, textCy, badgeW, badgeH);
        drawDigits(g, text, textX, baseline, size);
    }

    /**
     * 设置当前画笔色（描边 + 填充同时设）
     *
     * Graphics 的 strokeColor/fillColor 是**在 stroke()/fill() 调用时**才被读走并烘进顶点色的
     * （见引擎 graphics-assembler 的 `Color.copy(_curColor, graphics.strokeColor)`），
     * 所以这里复用一个 Color 实例是安全的，不会串色。
     */
    private setPaint(g: Graphics, rgb: number, alpha: number): void {
        this.paint.set(
            (rgb >> 16) & 0xff,
            (rgb >> 8) & 0xff,
            rgb & 0xff,
            Math.round(alpha * 255),
        );
        g.strokeColor = this.paint;
        g.fillColor = this.paint;
    }

    /** 字号 = 基准 × 档位 scale × 英雄受击加成 × pop 回弹 */
    private sizeOf(it: DamageTextItem, st: ReturnType<typeof getDamageTextStyle>): number {
        const hero = it.heroHurt ? DAMAGE_TEXT.heroScaleBonus : 1;
        let pop = 1;
        if (st.popTime > 0 && it.age < st.popTime) {
            // 起跳放大 → 线性回落到 1（暴击的"顿挫感"就在这 0.16 秒里）
            pop = 1 + (st.pop - 1) * (1 - it.age / st.popTime);
        }
        return DAMAGE_TEXT.baseFontSize * st.scale * hero * pop;
    }
}

/** 单个飘字的运行时数据（池化复用；绘制所需的一切都在这，不持有节点） */
interface DamageTextItem {
    /** 显示值（整数，合并时累加） */
    value: number;
    /** 档位（普通 / 暴击） */
    tier: DamageTextTier;
    /** 是否打在英雄身上（决定颜色与优先级） */
    heroHurt: boolean;
    /** 受击目标 uid（合并 / 阶梯 / 抖散都按它分组） */
    targetUid: number;
    /** 伤害来源 uid（怪物受击按来源分开合并） */
    sourceUid: number;
    /** 出生点 x（合并续期时会改写成当前位置） */
    x0: number;
    /** 出生点 y（已含出生抬高与阶梯层） */
    y0: number;
    /** 横向抖散偏移（合并续期时置 0，因为偏移已并入 x0） */
    offsetX: number;
    /** 已存活时长（秒） */
    age: number;
    /** 寿命（秒，出生时按档位取） */
    life: number;
    /** 淘汰优先级（越大越不容易被并发上限挤掉） */
    priority: number;
}

// ============ 纯函数小工具 ============

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 上浮缓动：起步快、末段慢（越飘越慢，观感更"轻"） */
function easeOutCubic(t: number): number {
    const inv = 1 - t;
    return 1 - inv * inv * inv;
}

/** 淡出：fadeFrom 之前不透明，之后线性淡到 0 */
function alphaOf(t: number, fadeFrom: number): number {
    if (t <= fadeFrom) return 1;
    const k = (t - fadeFrom) / (1 - fadeFrom);
    return k >= 1 ? 0 : 1 - k;
}

/** 按 uid 稳定散开的横向偏移（同一只怪的数字永远落在同一侧，不会左右乱跳） */
function stableScatter(uid: number): number {
    const h = Math.abs(uid * 2654435761) % 1024 / 1024; // 0~1 的稳定伪随机
    return (h * 2 - 1) * DAMAGE_TEXT.scatterRadius;
}
