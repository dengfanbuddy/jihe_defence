import { _decorator, Color, Label, Node, Sprite } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { StageScopeEvents, StageScopeKeys } from '../StageScope';
import { ShopConfig } from '../../../../../data/configs/ShopConfig';
import { rarityColor } from '../../../../../common/RelicRarityColor';
import { AtlasIcon } from '../../../../../common/AtlasIcon';
import { ITEM_BAG_DOUBLE_CLICK_SECONDS } from '../../../../../common/ItemBagConfig';
import type { ItemBagVM } from '../../../../../battle/ItemBag';

const { ccclass, property } = _decorator;

/**
 * 单个格子的**内部**事件：格子 → 面板（`scope.emit` 沿 `node.parent` 冒泡，`ItemBagPanel` 接住）。
 *
 * 为什么不去 `StageScopeEvents` 里加一条：那是**这一页的对外契约**（宿主 `Scene_Game_Stage` 接的），
 * 而"点一下格子看描述"是背包面板内部的私事，宿主不需要知道（要用道具走的是
 * `StageScopeEvents.BattleItemUse`，那条才是对外的）。
 *
 * 键定义在**发事件的一侧**（本文件），面板 import 它 —— 只有一个方向，不成环。
 */
export const ITEM_BAG_PICKED = 'itemBag:picked';

/** 子节点名（预制件 `item_bags/content/cells/cell_N` 下已经摆好；改名字要同步这里） */
const BG_NODE = 'bg';
const ICON_NODE = 'icon';
const NAME_NODE = 'name';

/** 空格子的底框色（= `c-surface-sunken` #D8D8D8；与局外背包空槽同一口径） */
const EMPTY_FRAME = new Color(216, 216, 216, 255);

/** 落格弹跳：时长（秒）与最大放大比例（格子里有字，晃大了看不清 —— 比 HUD 数值弹跳更克制） */
const PUNCH_SECONDS = 0.18;
const PUNCH_SCALE = 0.16;

/**
 * ItemBagCell —— **局内掉落 Buff 小背包里的一个格子**（内嵌 UI 小组件 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * ── 交互（用户口径 2026-11）──
 *   · **单击** → `emit(ITEM_BAG_PICKED, slot)`：由面板弹「这件道具是什么」的说明浮层
 *   · **双击**（同一个格子上两次点击间隔 < `ITEM_BAG_DOUBLE_CLICK_SECONDS`）→
 *     `emit(StageScopeEvents.BattleItemUse, slot)`：由宿主转给 `ItemBag.use`，**用掉那件**
 *   · 空格子点一下什么都不做（只把说明浮层收掉）—— 界面上不许出现"点不动又不说为什么"的按钮，
 *     所以空格子的底框是灰的（`c-surface-sunken`），一眼能看出里面没东西
 *
 * ⚠ **单击不等待双击窗口**：点一下立刻弹描述，够快就升级成"用掉"。若反过来（等 300ms 确认不是双击
 *   再弹描述），点一下会明显发涩 —— 玩家对"点一下有没有反应"的容忍度远低于 300ms。
 *
 * ── 通信 ──
 *   向下：只 inject 宿主 provide 的 `ItemBagVM`（格子内容 / 能不能用都从它读，
 *          **不许自己写 6、也不许自己存一份格子状态**）
 *   向上：只 `emit`，且**不直接改任何状态**（清格 / 施加效果都在 `ItemBag.use` 里）
 *
 * ⚠ 本组件由 `ItemBagPanel` 在运行时 `addComponent` 挂到预制件的 6 个格子节点上，
 *   所以子节点一律按名字取（`@property` 只是给将来编辑器接线留的口子）。
 */
@ccclass('ItemBagCell')
export class ItemBagCell extends UIWidget {

    /* ===== 编辑器可拖的引用（留空则按下面的节点名在自身子树里找） ===== */
    @property(Sprite)
    iconSprite: Sprite = null;
    @property(Label)
    nameLabel: Label = null;

    /**
     * 本格子是第几格（0 起）。面板逐个下发；
     * `-1`（组件刚挂上、赋值晚于 `onInit`）时按**兄弟顺序**自推，保证格号永远对得上。
     */
    slotIndex = -1;

    /* 宿主注入的功能门面（格子内容 / 可不可用都从它读） */
    private itemBag: ItemBagVM = null;

    /* 运行时解析出来的引用 */
    private frameSprite: Sprite = null;
    private iconNode: Node = null;

    /** 上一次点击本格子的时刻（用累计时钟算间隔，不用 Date.now —— 那是墙钟，会被系统时间改动影响） */
    private lastClickAt = -1;
    /** 本组件自己的时钟（`update` 推进） */
    private clock = 0;

    /**
     * 上一次取图用的 `icon` 路径。
     * 只用来**挡住重复取图**（`refresh` 会被格子内容 watch 反复调到）；
     * 图与失败结果的缓存在共用的 `AtlasIcon` 里，本组件不再自己存一份。
     */
    private iconPath = '';

    /* ===================================================================
     * UIWidget 生命周期
     * =================================================================== */

    protected onInit(): void {
        if (this.slotIndex < 0) this.slotIndex = this.node.getSiblingIndex();

        this.itemBag = this.inject<ItemBagVM>(StageScopeKeys.ItemBag, null);
        if (!this.itemBag) {
            ezgame.warn(`[道具背包] 第 ${this.slotIndex + 1} 格没注入到 ItemBag 门面（不在 Scene_Game_Stage 子树下？），格子不会刷新`);
        }

        this.resolveChildren();

        // 触摸：格子上判单击 / 双击（Button 只负责按下时的缩放反馈，不接它的 CLICK —— 那个没有双击概念）
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);

        // watcher 交给 scope：随显示隐藏 resume/pause、销毁自动回收
        this.scope.watch(() => this.itemBag?.slots.value, () => this.refresh());

        this.refresh();
    }

    protected onShow(): void {
        // 每次重新显示都按当前状态刷一遍（格子内容是普通字段，watch 补播不到的情形也有）
        this.resetClicks();
        this.refresh();
    }

    protected onHide(): void {
        this.resetClicks();
    }

    protected onDispose(): void {
        // ⚠ 这些节点都是本组件的后代：销毁时它们先被 `_destruct()`（字段清空），
        //   直接 `.off()` 会抛异常堵死引擎销毁队列 → 一律走 `offNodeEvent`
        this.offNodeEvent(this.node, Node.EventType.TOUCH_END, this.onTouchEnd, this);
    }

    update(dt: number): void {
        this.clock += dt;

        // 落格弹跳：`sin` 起落都回到 1，所以**收尾那一帧一定复位**（漏了会把缩放带进下一局）
        if (this.punchRemain > 0 && this.node?.isValid) {
            this.punchRemain = Math.max(0, this.punchRemain - dt);
            const t = 1 - this.punchRemain / PUNCH_SECONDS;
            const s = 1 + PUNCH_SCALE * Math.sin(Math.PI * t);
            this.node.setScale(s, s, 1);
            if (this.punchRemain <= 0) this.node.setScale(1, 1, 1);
        }
    }

    /* ===================================================================
     * 刷新（只读注入的状态 → 写节点；watch 与该显示的公共出口）
     * =================================================================== */

    /** 按当前格子的内容刷一遍：底框色（品质）/ 名字 / 图标 */
    refresh(): void {
        const cfg = this.itemBag ? this.itemBag.cfgAt(this.slotIndex) : undefined;

        // ① 底框：有道具 = 品质色，空 = 灰（品质只在配色上表现，不进出图 —— 同遗物口径）
        if (this.frameSprite) {
            this.frameSprite.color = cfg ? new Color(rarityColor(cfg.rarity)) : EMPTY_FRAME.clone();
        }

        // ② 名字（表里没配图标时，名字就是这个格子唯一的识别信息）
        if (this.nameLabel) this.nameLabel.string = cfg ? cfg.name : '';

        // ③ 图标（`battle_items.icon`，2026-11 起 17 行全都有图 —— 图集 `textures/buffs/buffs`）
        this.applyIcon(cfg?.icon ?? '');
    }

    /** 播放一次"道具落进这一格"的弹跳 */
    punch(): void {
        if (!this.node?.isValid) return;
        this.node.setScale(1, 1, 1);
        this.punchRemain = PUNCH_SECONDS;
    }

    /* ===================================================================
     * 触摸：单击看描述 / 双击用掉
     * =================================================================== */

    private onTouchEnd(): void {
        const cfg = this.itemBag ? this.itemBag.cfgAt(this.slotIndex) : undefined;
        if (!cfg) {
            // 空格子：不算点击（但要把说明浮层收掉 —— 等同于"点了一下别处"）
            this.resetClicks();
            this.scope.emit(ITEM_BAG_PICKED, -1);
            return;
        }

        const doubleClick = this.lastClickAt >= 0 && (this.clock - this.lastClickAt) <= ITEM_BAG_DOUBLE_CLICK_SECONDS;
        if (doubleClick) {
            this.resetClicks();
            // 探针：双击没反应时先看它有没有打出来（没有 = 触摸事件没到格子）
            ezgame.info(`[道具背包] 双击第 ${this.slotIndex + 1} 格「${cfg.name}」→ 请求使用`);
            this.scope.emit(StageScopeEvents.BattleItemUse, this.slotIndex);
            return;
        }

        this.lastClickAt = this.clock;
        this.scope.emit(ITEM_BAG_PICKED, this.slotIndex);
    }

    private resetClicks(): void {
        this.lastClickAt = -1;
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** 按名字解析子节点（预制件里已有，没拖引用时用这条） */
    private resolveChildren(): void {
        if (!this.iconSprite) {
            this.iconNode = this.node.getChildByName(ICON_NODE);
            this.iconSprite = this.iconNode ? this.iconNode.getComponent(Sprite) : null;
        } else {
            this.iconNode = this.iconSprite.node;
        }
        if (!this.nameLabel) {
            const n = this.node.getChildByName(NAME_NODE);
            this.nameLabel = n ? n.getComponent(Label) : null;
        }
        // 底框就是格子根节点自己的 Sprite（预制件里作者摆好的那一个）
        this.frameSprite = this.node.getComponent(Sprite)
            ?? this.node.getChildByName(BG_NODE)?.getComponent(Sprite)
            ?? null;

        if (!this.nameLabel) ezgame.warn(`[道具背包] 第 ${this.slotIndex + 1} 格找不到 \`${NAME_NODE}\` 子节点，道具名不会显示`);
    }

    /**
     * 配了图标才显示（没配时整块收起，格子只留名字）。
     *
     * ⚠ **必须走 `AtlasIcon`**，不能自己 `resources.load('<path>/spriteFrame')`：
     * 2026-11 起这批图标只在**图集**里（`textures/buffs/buffs.plist` + `.png` 一对），
     * 碎图路径一律取不到 —— 直连碎图 = 每格都报一条"加载失败"、图标永远不出现。
     * 三级降级（图集本体 → 帧子资源 → 旧碎图）与"命中哪条路"的日志都在 `AtlasIcon` 里。
     */
    private applyIcon(path: string): void {
        if (!this.iconSprite) return;
        if (!path) {
            this.iconPath = '';
            this.iconSprite.spriteFrame = null;
            if (this.iconNode) this.iconNode.active = false;
            return;
        }
        if (this.iconNode) this.iconNode.active = true;
        // 同一件道具不重复取图（`AtlasIcon` 也按路径缓存，这里挡的是每次 watch 都重新走一遍异步的开销）
        if (path === this.iconPath) return;
        this.iconPath = path;

        AtlasIcon.loadIconFrame(path).then((sf) => {
            if (!sf) {
                // 表里**不许填不存在的路径** —— 这条是真配置错误，报出来（同一路径每格只报一次）
                ezgame.error(`[道具背包] 道具图标没取到：${path}`);
                return;
            }
            // 异步回来时这一格可能已经换成别的道具了 → 只认"还在等这张图"的自己
            if (this.iconSprite?.isValid && this.iconPath === path) this.iconSprite.spriteFrame = sf;
        });
    }

    /** 弹跳的剩余时间（帧驱动，不用 tween —— 池化/销毁时不会留下定时器） */
    private punchRemain = 0;
}
