import { _decorator, Color, Component, Graphics, instantiate, Node, NodePool, Prefab, resources, Vec3 } from 'cc';
import { BattleEvents } from '../../battle';
import type { BattleContext } from '../../battle';
import type { MineRecord, BurnField } from '../../battle/BattleMines';
import {
    MINE_DEFAULTS, MINE_LAYER_NODE_NAME, MINE_LAYER_STYLE, MINE_PREFAB_PATH,
} from '../../common/MineConfig';
import { MineView } from './MineView';

const { ccclass } = _decorator;

/** 场上一颗雷的视图槽位（`id === null` = 这颗已经引爆，节点还在播爆炸、播完回收） */
interface MineSlot {
    node: Node;
    view: MineView;
    /** 绑定的逻辑雷 id（`MineRecord.id`） */
    id: number | null;
    /** 上一次喂给视图的触发半径（变了才重画） */
    triggerRadius: number;
}

/** 本帧收到的一次引爆上报（位置 + 真实爆炸半径），由 `update` 来认领 */
interface BlastReport {
    x: number;
    y: number;
    radius: number;
}

/**
 * ============================================================
 * MineLayer —— 「骷髅地雷」的表现层（2026-11 从"整层一个 Graphics"改成**每颗雷一个预制件节点**）
 * ============================================================
 *
 * ── 画什么、谁画 ──
 *   · **每一颗雷**（实线小圆 + 引信点 + **真实触发半径**上的虚线雷达盘 + 旋转扫描线）：
 *     由该颗雷自己的**预制件节点**画 —— `prefabs/unit/mines/mine.prefab` + `MineView`；
 *     本层只负责"照 `ctx.mines.list()` 摆节点、按 id 回收"。
 *   · **爆炸**（圆圈从原点快速扩散到真实爆炸半径）：也是那个节点画的（`MineView.playBlast`）。
 *   · **燃烧地面**（遗物「燃烧雷」留下的火）：仍然画在**本层自己的 Graphics** 上 ——
 *     它不是"一颗雷"（没有 id、不进池子、会自己到期消失），为它建一套节点池是纯浪费。
 *
 * ── 为什么从"整层一个 Graphics"改掉 ──
 *   ① 用户口径：雷要**做成预制件**（外观该能在编辑器里改、能挂动画/换图，而不是写死在绘制代码里）；
 *   ② 扫描线需要"每颗雷自己的相位"，以及**爆炸期间本体和扫描要收掉** ——
 *      在一张共享画布上做这些要靠一堆 per-mine 状态，反而比节点更绕。
 *   ⚠ 代价：从"恒定 1 次 draw call"变成"每颗雷 1 个节点"（场上最多 5 颗 + 几片燃烧地面），
 *     这个量级下无所谓；**但别把这条经验推广到大数量的实体**（怪物/弹道是另一套池子）。
 *
 * ── 三条硬约束（都是既有层踩过的坑，照抄口径）──
 *   ① **坐标系契约**：本层按**逻辑世界坐标**摆节点、**不做任何坐标转换** ——
 *      `EntityView.bind` 是 `node.setPosition(entity.position)`，即 `monsterParent` 的局部空间
 *      == 逻辑世界坐标。所以层节点必须与 `monsterParent` **同坐标系**（根下兄弟、position (0,0)、
 *      scale 1）。`bind` 时做一次自检（`checkSpace`），挪了位置会打警告。
 *   ② **本层只读 `ctx.mines`**：布雷 / 触发 / 伤害全在纯 TS 的 `BattleMines` 里
 *      （它不依赖 cc，所以能被体检脚本真跑）。表现层碰战斗逻辑 = 那条体检就白做了。
 *   ③ **预制件加载失败不许静默**：`resources.load` 失败会打一条 error 并只在**换局重 bind 时**重试
 *      （每帧重试会把控制台刷爆）。失败时逻辑照常（雷照埋、照炸、照结算），只是**看不见**。
 *
 * ── 引爆怎么认出来（本文件唯一的"小算法"）──
 *   `BattleMines.detonate` 只 `reportBlast(x, y, radius)`（音效/顿帧那条路），
 *   **没有"哪一颗炸了"的回调**，而本层要的正是"**在那颗的节点上**播扩散圈"。两条判据合起来用：
 *     · **主判据 = id diff**：上一帧还在的 id、这一帧不在了 = 引爆 ——
 *       位置与"哪一颗"都是准的，而且**不依赖任何总线**；
 *     · **补判据 = `OnSkillShape` 里 `noDraw` 的那条爆炸上报**（地雷上报时打的标记）：
 *       ① 给主判据补上**真实爆炸半径**（引物「扩爆」改的就是它）；
 *       ② 补上主判据天生看不到的那一类 —— **埋下与被踩发生在同一帧**的雷
 *          （`BattleMines.tick` 里布雷在 ①、触发判定在 ③，那颗雷从没进过本层的列表）。
 *   ⚠ **换局/换英雄的清场**也表现为"id 全没了"，两者靠 `stats.detonated`（这一帧真的炸了几颗**有账**）
 *     分开：消失得比账多 ⇒ 清场，**不播爆炸**、直接回收。
 */
@ccclass('MineLayer')
export class MineLayer extends Component {
    /** 燃烧地面的画布（本层自己的 Graphics；雷本体不在上面画了） */
    private g: Graphics | null = null;
    private ctx: BattleContext | null = null;
    /** 坐标系参照节点（= 场景的 monsterParent）；null = 还没 bind */
    private ref: Node | null = null;
    /** 坐标系自检只报一次（否则每帧刷屏） */
    private spaceChecked = false;
    /** 上一帧画过燃烧地面没有（用于"空了才清一次"） */
    private fieldDrawn = false;
    /** 总线退订句柄（换局必须退，否则旧上下文的爆炸会打到新一局） */
    private unsubShape: (() => void) | null = null;

    /** 地雷预制件（异步加载；没到位时雷暂时看不见，到位后自动补上，见 `acquire`） */
    private prefab: Prefab | null = null;
    private loadingPrefab = false;
    private prefabFailed = false;
    /** 节点池（本层自己持有；换局**不清池**，只有组件销毁才 clear） */
    private pool = new NodePool();
    /** 场上的槽位（含正在播爆炸的） */
    private slots: MineSlot[] = [];
    /** id → 槽位（每帧的 diff 靠它，别在数组里线性找） */
    private byId = new Map<number, MineSlot>();
    /** 上一帧读到的引爆总数（用来把"引爆"与"清场"分开，见文件头） */
    private lastDetonated = 0;
    /** 本帧收到、还没被 `update` 认领的引爆上报 */
    private pendingBlasts: BlastReport[] = [];

    onLoad(): void {
        // 燃烧地面仍然画在本层节点上（雷本体/爆炸已经各自有预制件节点了）
        this.g = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
        this.g.lineCap = Graphics.LineCap.ROUND;
        this.g.lineJoin = Graphics.LineJoin.ROUND;
        this.g.clear();
    }

    /**
     * 接上战斗上下文。
     *
     * @param ctx 战斗上下文（`ctx.mines` 是唯一数据源）
     * @param coordRef **坐标系参照节点**（通常传 `monsterParent`）：用于自检"本层与它同坐标系"
     */
    bind(ctx: BattleContext, coordRef?: Node | null): void {
        this.unsubShape?.();
        this.unsubShape = null;
        this.ctx = ctx;
        this.ref = coordRef ?? null;
        this.spaceChecked = false;
        this.lastDetonated = ctx?.mines?.stats?.detonated ?? 0;
        this.pendingBlasts.length = 0;
        this.prefabFailed = false;      // 换局重 bind 时再给预制件一次机会
        // 引爆上报（见文件头"引爆怎么认出来"）：只接**上报方自己画**的那条（`noDraw`）
        const bus: any = (ctx as any)?.bus;
        if (bus?.onBattleEvent) {
            this.unsubShape = bus.onBattleEvent(BattleEvents.OnSkillShape, this.onShape, this);
        }
        this.ensurePrefab();
        this.checkSpace();
    }

    /**
     * 断引用（换局时由宿主调；节点保留，下次进战斗重新 bind）。
     *
     * ⚠ **清场不播爆炸**：换局时场上的雷是被"丢掉"的，不是被踩响的 ——
     *   播 5 个扩散圈会读成"上一局结算时全炸了"。
     */
    unbind(): void {
        this.unsubShape?.();
        this.unsubShape = null;
        this.ctx = null;
        this.clearAll();
    }

    /** 清空画面（宿主在换局/结束时会调；雷节点全部回收，燃烧地面擦掉） */
    clearAll(): void {
        for (let i = this.slots.length - 1; i >= 0; i--) this.recycle(i);
        this.byId.clear();
        this.lastDetonated = 0;
        this.pendingBlasts.length = 0;
        this.g?.clear();
        this.fieldDrawn = false;
    }

    /** 组件销毁：池子里的节点也一起销毁（不 clear 会漏节点，引擎不会替我们回收） */
    onDestroy(): void {
        this.unsubShape?.();
        this.unsubShape = null;
        this.pool.clear();
        this.slots.length = 0;
        this.byId.clear();
        this.pendingBlasts.length = 0;
    }

    update(dt: number): void {
        const mines: any = this.ctx?.mines;
        // ① 雷（含爆炸中的）：照 `ctx.mines` 摆节点
        if (mines) this.syncViews(mines.list(), dt);
        // ② 燃烧地面：仍然画本层自己的画布
        this.drawFields(mines?.burnFields() ?? []);
    }

    /* ------------------------------------------------------------------ 雷节点 */

    /**
     * 引爆上报（总线上那条 `noDraw` 的爆炸）：**只记账，不立刻画** ——
     * 画要等 `update` 把"哪一颗"认出来（连带把本体与雷达盘一起收掉），见文件头。
     */
    private onShape(e: any): void {
        if (!this.ctx || !e || e.noDraw !== true) return;
        if (!Number.isFinite(e.cx) || !Number.isFinite(e.cy)) return;
        const radius = Number(e.radius);
        if (!(radius > 0)) return;
        // 上界兜底：一帧最多引爆 5 颗（连锁雷/引爆器也就是这个量级），脏数据不许把数组撑爆
        if (this.pendingBlasts.length >= 16) return;
        this.pendingBlasts.push({ x: e.cx, y: e.cy, radius });
    }

    /**
     * 把场上的雷同步成节点（**每帧全量对一遍 id**：最多 5 颗，比任何增量记账都便宜且不会漏）。
     *
     * 顺序：先认引爆（消失的 id）→ 再补新雷 → 最后喂触发半径 + 推进动画。
     * "先认引爆"不能颠倒：同一帧里"上一颗刚炸掉、新一颗刚埋下"是常态（连锁雷 + 布雷同帧）。
     */
    private syncViews(list: readonly MineRecord[], dt: number): void {
        const mines: any = this.ctx?.mines;
        const rt = mines?.runtime?.();
        const triggerRadius = Number(rt?.triggerRadius) || 0;
        const blastRadius = Number(rt?.blastRadius) || 0;

        // ① 消失的 id = 引爆（除非消失得比"引爆账"多 ⇒ 那是清场）
        const live = new Set<number>();
        for (let i = 0; i < list.length; i++) live.add(list[i].id);

        let vanished = 0;
        for (let i = 0; i < this.slots.length; i++) {
            const s = this.slots[i];
            if (s.id !== null && !live.has(s.id)) vanished++;
        }
        const detonatedNow = Number(mines?.stats?.detonated) || 0;
        const detonatedDelta = detonatedNow - this.lastDetonated;
        this.lastDetonated = detonatedNow;
        /** 这一帧的"消失"是不是真的引爆（清场时 detonated 增量对不上） */
        const realBlast = detonatedDelta > 0 && vanished <= detonatedDelta;

        for (let i = this.slots.length - 1; i >= 0; i--) {
            const s = this.slots[i];
            if (s.id === null || live.has(s.id)) continue;
            this.byId.delete(s.id);
            s.id = null;
            if (!realBlast) {
                this.recycle(i);                        // 清场：不留爆炸，直接回收
                continue;
            }
            // 半径优先用**这一次引爆自己的上报**（引物「扩爆」改的就是它）；没有就用当前重算值
            const p = s.node.position;
            const rep = this.takeBlastAt(p.x, p.y);
            s.view.playBlast(rep ? rep.radius : (blastRadius > 0 ? blastRadius : MINE_DEFAULTS.blastRadius));
        }

        // ①' 没认领到任何雷的上报 = **埋下与被踩在同一帧**的那一类
        //     （`BattleMines.tick` 里布雷在 ①、触发判定在 ③ ⇒ 它从没进过本层的列表）。
        //     逻辑上它确实炸了，所以照画：临时借一个节点播完就还（不画本体）。
        if (this.pendingBlasts.length) {
            const rest = this.pendingBlasts;
            this.pendingBlasts = [];
            for (let i = 0; i < rest.length; i++) {
                const slot = this.acquire();
                if (!slot) break;
                slot.node.setPosition(rest[i].x, rest[i].y, 0);
                slot.view.playBlast(rest[i].radius);
            }
        }

        // ② 新雷：取节点、摆位置、进入警戒
        for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (this.byId.has(m.id)) continue;
            const slot = this.acquire();
            if (!slot) break;                           // 预制件还没到位：下一帧再补（不阻塞逻辑）
            slot.id = m.id;
            slot.triggerRadius = triggerRadius;
            slot.node.setPosition(m.x, m.y, 0);
            slot.view.arm(triggerRadius);
            this.byId.set(m.id, slot);
        }

        // ③ 参数每帧重算（遗物「扩爆」/ 换英雄都会改它）→ 变了才重画
        for (let i = 0; i < this.slots.length; i++) {
            const s = this.slots[i];
            if (s.id === null || Math.abs(s.triggerRadius - triggerRadius) < 0.01) continue;
            s.triggerRadius = triggerRadius;
            s.view.setTriggerRadius(triggerRadius);
        }

        // ④ 推进动画 + 回收播完爆炸的节点（**倒序**：回收会 splice）
        for (let i = this.slots.length - 1; i >= 0; i--) {
            const s = this.slots[i];
            s.view.tick(dt);
            if (s.id === null && s.view.blastFinished) this.recycle(i);
        }
    }

    /**
     * 取走"落在 (x, y) 上"的那条引爆上报（同一颗雷的坐标是同一个数，判据给半像素容差）。
     *
     * @returns 认领到的那条；没有 = 这一发没有上报（总线没接 / 换局），调用方走重算半径
     */
    private takeBlastAt(x: number, y: number): BlastReport | null {
        for (let i = 0; i < this.pendingBlasts.length; i++) {
            const b = this.pendingBlasts[i];
            if (Math.abs(b.x - x) < 0.5 && Math.abs(b.y - y) < 0.5) {
                this.pendingBlasts.splice(i, 1);
                return b;
            }
        }
        return null;
    }

    /** 从池子里取一个雷节点（没有预制件时返回 null —— 调用方下一帧再试） */
    private acquire(): MineSlot | null {
        this.ensurePrefab();
        const prefab = this.prefab;
        if (!prefab) return null;
        let node = this.pool.get();
        if (!node) node = instantiate(prefab);
        node.parent = this.node;
        // ⚠ 不继承 layer 的话 UI 相机看不到（同 `attachMineLayer` 那条坑；预制件里的 layer 也可能被改错）
        node.layer = this.node.layer;
        node.active = true;
        let view = node.getComponent(MineView);
        if (!view) view = node.addComponent(MineView);   // 手滑把组件删了也不至于"什么都看不见"
        const slot: MineSlot = { node, view, id: null, triggerRadius: 0 };
        this.slots.push(slot);
        return slot;
    }

    /** 回收一个槽位（节点留在池子里、挂在层节点下不激活） */
    private recycle(index: number): void {
        const s = this.slots[index];
        if (!s) return;
        this.slots.splice(index, 1);
        if (s.id !== null) this.byId.delete(s.id);
        s.view.reset();
        s.node.active = false;
        this.pool.put(s.node);
    }

    /**
     * 载入预制件（**只在 bind 与首次需要时各试一次**，失败不每帧重试）。
     *
     * 失败时逻辑照常跑（雷照埋、照炸、照结算），只是玩家看不见 —— 所以必须打 error，
     * 而且要把路径写清楚（"看不见任何东西"是这类问题里最难查的一种）。
     */
    private ensurePrefab(): void {
        if (this.prefab || this.loadingPrefab || this.prefabFailed) return;
        this.loadingPrefab = true;
        resources.load(MINE_PREFAB_PATH, Prefab, (err, prefab) => {
            this.loadingPrefab = false;
            if (err || !prefab) {
                this.prefabFailed = true;
                console.error(
                    `[地雷层] 预制件加载失败：resources/${MINE_PREFAB_PATH}.prefab —— `
                    + '场上的雷不会有任何表现（逻辑照常：照埋、照炸、照结算）。换局时会自动再试一次。',
                    err,
                );
                return;
            }
            this.prefab = prefab;
        });
    }

    /* ------------------------------------------------------------------ 燃烧地面 */

    /**
     * 燃烧地面（遗物「燃烧雷」留下的那片火）：更大的虚线环 + 几条内刻度，不填充。
     *
     * 仍画在本层自己的画布上（见文件头"画什么、谁画"）；**没东西可画时不 clear**
     * （空地雷时每帧 clear 一次是白扔 draw call）。
     */
    private drawFields(fields: readonly BurnField[]): void {
        const g = this.g;
        if (!g) return;
        if (!fields.length) {
            if (this.fieldDrawn) {
                g.clear();
                this.fieldDrawn = false;
            }
            return;
        }
        g.clear();
        for (const f of fields) {
            const s = MINE_LAYER_STYLE;
            this.dashedCircle(g, f.x, f.y, f.radius, s.fieldDashCount, s.burnColor, s.fieldLineWidth);
            // 内刻度：八向短线，读作"这里在持续烧"
            const r0 = f.radius * 0.62;
            const r1 = f.radius * 0.86;
            g.strokeColor = new Color(s.burnColor[0], s.burnColor[1], s.burnColor[2], 255);
            for (let i = 0; i < 8; i++) {
                const a = (Math.PI * 2 * i) / 8;
                g.moveTo(f.x + Math.cos(a) * r0, f.y + Math.sin(a) * r0);
                g.lineTo(f.x + Math.cos(a) * r1, f.y + Math.sin(a) * r1);
            }
            g.stroke();
        }
        this.fieldDrawn = true;
    }

    /** 画一圈虚线（`Graphics` 没有 dash 原语 ⇒ 按段画圆弧） */
    private dashedCircle(
        g: Graphics, cx: number, cy: number, radius: number,
        dashCount: number, rgb: readonly number[], lineWidth: number,
    ): void {
        g.lineWidth = lineWidth;
        g.strokeColor = new Color(rgb[0], rgb[1], rgb[2], 255);
        const n = Math.max(4, Math.round(dashCount));
        const step = (Math.PI * 2) / (n * 2);
        for (let i = 0; i < n; i++) {
            const a0 = i * step * 2;
            const a1 = a0 + step;
            g.moveTo(cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius);
            g.lineTo(cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius);
        }
        g.stroke();
    }

    /* ------------------------------------------------------------------ 自检 */

    /**
     * 坐标系自检（**只报一次**）：本层必须与参照节点同坐标系。
     *
     * 为什么值得一条自检：绘制**不做坐标转换**（约束 ①），所以"层级摆错"不会报错、
     * 只会让雷**长在屏幕的另一个角落** —— 那种 bug 在编辑器里点不出来，只有在真机上看才现形。
     * 判据 = 两者的世界坐标相同（根下兄弟、(0,0)、scale 1 时成立）。
     */
    private checkSpace(): void {
        if (this.spaceChecked || !this.ref?.isValid) return;
        this.spaceChecked = true;
        const a = new Vec3();
        const b = new Vec3();
        this.node.getWorldPosition(a);
        this.ref.getWorldPosition(b);
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        const floor = 0.5; // 半个像素以内当作同一坐标系
        const dx0 = dx < floor ? 0 : dx;
        const dy0 = dy < floor ? 0 : dy;
        if (dx0 > 0 || dy0 > 0) {
            console.warn(
                `[地雷层] 本层与 monsterParent 不在同一坐标系（世界坐标差 ${dx0.toFixed(1)},${dy0.toFixed(1)}）——`
                + ' 地雷会画在错误的位置。本层不做坐标转换，层节点必须与怪物层同父、position (0,0)、scale 1。',
            );
        }
    }
}

/** 兜底：宿主没建节点时可以就地建一个（见 `Scene_Game_Stage.ensureMineLayer`） */
export function attachMineLayer(parent: Node, name = MINE_LAYER_NODE_NAME): MineLayer {
    const node = new Node(name);
    node.layer = parent.layer;      // ⚠ 不继承 layer 的话 UI 相机看不到（同飘字层那条坑）
    parent.addChild(node);
    return node.addComponent(MineLayer);
}
