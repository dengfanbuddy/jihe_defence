import { _decorator, Color, Label, Node, Sprite } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { AtlasIcon } from '../../../common/AtlasIcon';
import { rarityColor } from '../../../common/RelicRarityColor';
import { BAG_CELL_NODE, BAG_EMPTY_FRAME, BagScopeEvents, type BagCellVM } from './BagScope';

const { ccclass, property } = _decorator;

/**
 * 数量标签：**只有 2 件以上才显示**（`×1` 是噪声 —— 一格既然在，就说明至少有 1 件）。
 * 口径写在这里而不是散在判断里：将来若要"1 也显示"，只改这一行。
 */
const COUNT_VISIBLE_FROM = 2;

/**
 * 背包列表里的**一个格子**（内嵌 UI 小组件 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * 职责只有两件（与 `TaskItem` / `OuterRelicItem` 同一分工）：
 *   ① 渲染：把宿主下发的 `BagCellVM` 画到预制件上（品质底框色 / 图标 / 数量 / 可选倒计时 / 选中环）；
 *   ② 通知：点一下 `scope.emit(BagScopeEvents.SelectItem, key)` —— 换选中、重画详情都是**页面**的事。
 *
 * ⚠ **两种形态**（`vm.empty` 分派，2026-11）：**有货的格子** 与 **空槽**。空槽只画一格灰底
 *   （`BAG_EMPTY_FRAME`，与详情面板的"未选中"底框**共用同一个常量**），图标/数量/倒计时/选中环全收起、
 *   点了也不冒泡 —— 这样"背包是空的"与"背包里有 80 个位置"这两件事在界面上是分得开的
 *   （铺满 80 格是**判据层**的决定，见 `BagVM`）。
 *
 * 组件是**运行时挂的**（`View_Bag.ensureCells()` 给 content 下的模板格子 addComponent），
 * 所以子节点引用全按名字兜底解析（`@property` 没拖也能跑）。
 *
 * ⚠ **品质只染"底框"这一处**（本节点自己的 Sprite），与图鉴页 `OuterRelicItem` 的口径一致：
 *   图标保持墨色、名字保持墨色 —— 白档 `#DDDDDD` 若染到文字上，在纸面底上根本读不出来。
 */
@ccclass('BagItem')
export class BagItem extends UIWidget {

    /** 品质底框 = **本节点自己的 Sprite**（预制件里 `rect_rd_20` 白色圆角九宫格） */
    @property(Sprite)
    frame: Sprite = null;
    /** 选中环（预制件里 `rect_board_rd_10`；**只切显隐、不染色** —— 环是烤进贴图的青绿，染色会发脏） */
    @property(Sprite)
    ring: Sprite = null;
    @property(Sprite)
    icon: Sprite = null;
    @property(Label)
    countLabel: Label = null;
    /** 有效期倒计时（静置 `active=false`；只在 `expireAt > 0` 时显示） */
    @property(Node)
    timerNode: Node = null;
    @property(Label)
    timerLabel: Label = null;

    /** 这一格装的是哪件道具（`''` = 空槽 / 还没设过） */
    private itemKey = '';
    /** 当前这一格的过期时间戳（ms；0 = 永久。`tickTimer` 每秒按它重算文字） */
    private expireAt = 0;
    /** 这一格是不是空槽（空槽点了不冒泡、也不画图标/数量/倒计时，见 `setInfo`） */
    private isEmpty = true;

    // ────────────── 生命周期 ──────────────

    protected onInit(): void {
        this.resolveRefs();
        // 格子没有 Button（预制件里是纯 Sprite 节点）→ 节点触摸当点击（与主界面底部页签同口径）
        this.node.on(Node.EventType.TOUCH_END, this.onClick, this);
    }

    protected onDispose(): void {
        // 事件挂在自己的节点上，退订走 offNodeEvent 兜底（见 AGENTS.md「表现层 onDestroy」）
        this.offNodeEvent(this.node, Node.EventType.TOUCH_END, this.onClick, this);
    }

    // ────────────── 对外：宿主下发数据 ──────────────

    /** 这一格装的是哪件道具（`''` = 空槽） */
    getKey(): string {
        return this.itemKey;
    }

    /** 这一格是不是空槽（"位置在这儿、里面没东西"） */
    isEmptySlot(): boolean {
        return this.isEmpty;
    }

    /**
     * 填一格。**两种形态**（由 `BagCellVM.empty` 分派）：
     *   · **有货**：品质底框 + 图标 + 可选数量 / 倒计时 + 可选选中环；
     *   · **空槽**：只画一格 `EMPTY_FRAME` 灰底，图标 / 数量 / 倒计时 / 选中环**全部收起**
     *     （空槽没有品质、没有数量，也就没有"选中"这回事）。
     *
     * `vm = null` 时整格收起 —— 运行期不会走到（判据层恒补满 80 格），留着是给
     * "格子数多于 VM"这种不该发生的状态一个收场，不至于把上一件道具留在那儿。
     */
    setInfo(vm: BagCellVM | null): void {
        if (!vm) {
            this.itemKey = '';
            this.isEmpty = true;
            this.expireAt = 0;
            this.node.active = false;
            return;
        }
        this.node.active = true;
        this.itemKey = vm.empty ? '' : vm.key;
        this.isEmpty = !!vm.empty;
        this.expireAt = this.isEmpty ? 0 : Math.max(0, vm.expireAt || 0);

        // 品质色只有**一个**落点：底框（见类头 ⚠）；空槽走灰底、不碰品质色
        const frame = this.ensureFrame();
        if (frame) frame.color = new Color().fromHEX(this.isEmpty ? BAG_EMPTY_FRAME : rarityColor(vm.rarity));

        // 选中环只切显隐；环的颜色不动（烤进贴图的青绿，染色会得到脏色）。
        // ⚠ 空槽恒不画环：环的意思是"详情面板里显示的就是这一件"，空槽没有详情可显示。
        if (this.ring) this.ring.node.active = !this.isEmpty && vm.selected;

        if (this.countLabel) {
            const show = !this.isEmpty && vm.count >= COUNT_VISIBLE_FROM;
            this.countLabel.node.active = show;
            if (show) this.countLabel.string = `×${vm.count}`;
        }

        // 图标：空槽**不加载也不显示**（省掉 68 次异步加载；留着上一次的图会变成幽灵图标）
        if (this.icon) this.icon.node.active = !this.isEmpty;
        if (!this.isEmpty) this.loadIcon(vm.icon);

        this.tickTimer();
    }

    /**
     * 秒级刷新：只重写倒计时那一行（**不重建整格**）。
     * 页面每秒调一次（`View_Bag.tickClock`）；`expireAt = 0`（永久）时把整块 `timer` 收起。
     */
    tickTimer(): void {
        if (!this.timerNode) return;
        if (!(this.expireAt > 0)) {
            this.timerNode.active = false;
            return;
        }
        const left = Math.floor((this.expireAt - Date.now()) / 1000);
        if (left <= 0) {
            // 归零就先收起 —— 真正的"删掉这一格"由页面重刷
            // （`View_Bag.tickClock` → `pruneExpired()` → 指纹变 → watcher → refresh）
            this.timerNode.active = false;
            return;
        }
        this.timerNode.active = true;
        if (this.timerLabel) this.timerLabel.string = formatClock(left);
    }

    // ────────────── 内部 ──────────────

    /** 点一下：只通知页面「选我」（选谁、详情画什么都在页面那边算）。**空槽点了什么都不发生** */
    private onClick(): void {
        if (this.isEmpty || !this.itemKey) return;
        this.scope.emit(BagScopeEvents.SelectItem, this.itemKey);
    }

    /**
     * 品质底框 = **本节点自己的 Sprite**（与 `OuterRelicItem.ensureBorder` 逐字同口径）。
     * 返回 null 说明预制件缺 Sprite —— 那时只是没有品质底框，其余部分照画。
     */
    private ensureFrame(): Sprite {
        if (this.frame?.isValid) return this.frame;
        this.frame = this.node.getComponent(Sprite) ?? null;
        return this.frame;
    }

    /** 加载图标（`bag_items.icon`；走共享的三级降级 `AtlasIcon`）。没配图标 = 保持预制件占位图 */
    private loadIcon(url: string): void {
        if (!this.icon || !url) return;
        AtlasIcon.loadIconFrame(url).then((sf) => {
            if (sf && this.icon?.isValid) this.icon.spriteFrame = sf;
        });
    }

    /**
     * 按名字兜底解析子节点（预制件里没拖 `@property` 也能跑）。
     * 子节点契约（与 `prefabs/ui/views/bag/cmps/Bag_Cell.prefab` 一致，常量在 `./BagScope`）：
     *   ring / icon / count / timer[label]
     */
    private resolveRefs(): void {
        const n = this.node;
        this.ring = this.ring ?? n.getChildByName(BAG_CELL_NODE.ring)?.getComponent(Sprite);
        this.icon = this.icon ?? n.getChildByName(BAG_CELL_NODE.icon)?.getComponent(Sprite);
        this.countLabel = this.countLabel ?? n.getChildByName(BAG_CELL_NODE.count)?.getComponent(Label);
        const timer = n.getChildByName(BAG_CELL_NODE.timer);
        this.timerNode = this.timerNode ?? timer;
        this.timerLabel = this.timerLabel ?? timer?.getChildByName(BAG_CELL_NODE.timerLabel)?.getComponent(Label);

        if (!this.icon || !this.countLabel) {
            console.warn('[BagItem] 子节点契约不完整（需要 icon / count）：', n.name);
        }
    }
}

/**
 * `秒` → `HH:MM:SS`（与 `View_Shop` 的同名函数同一把尺；只有倒计时文字，不配时钟图标）。
 * 不用 `padStart`：工程 target 的 lib 到不了 ES2017，全量 `tsc` 会报 TS2550。
 */
function formatClock(sec: number): string {
    const total = Math.max(0, Math.floor(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p2 = (v: number): string => (v < 10 ? `0${v}` : `${v}`);
    return `${p2(h)}:${p2(m)}:${p2(s)}`;
}
