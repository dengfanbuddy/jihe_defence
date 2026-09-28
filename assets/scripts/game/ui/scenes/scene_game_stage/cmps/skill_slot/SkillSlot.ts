import { _decorator, Color, Label, Node, Sprite, SpriteFrame, resources } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { StageScopeEvents, StageScopeKeys } from '../StageScope';
import { ShopConfig, type ShopRarity } from '../../../../../data/configs/ShopConfig';
import type { SkillSlotState, SkillSlotsVM } from '../../../../../battle/SkillSlots';

const { ccclass, property } = _decorator;

/** 长按判定阈值（秒）——手按住超过这么久才弹详情面板 */
const LONG_PRESS_SECONDS = 0.4;

/** 没有配 `icon` 时的兜底图（单位技能与肉鸽技能现在都没配图标，见 abilities.json 的 icon 列） */
const PLACEHOLDER_ICON = 'textures/skills/bullet';

/** 锁定 / 未锁定两张图（`lock` 节点的 Sprite 会在这两张之间切） */
const LOCK_ICON = 'textures/common/lock';
const UNLOCK_ICON = 'textures/common/unlock';

/** 技能品质配色（与商店 item 同一套四档配色） */
const RARITY_COLOR: Record<ShopRarity, string> = {
    common: '#DDDDDD',
    rare: '#5096FF',
    epic: '#CF68FF',
    legendary: '#FF6464',
};

/**
 * 底框（槽位根节点上的 Sprite）**代码一律不动**。
 *
 * 需求口径：「没技能的时候只是不显示 icon，背景框还是要显示的」——
 * 所以空槽与有技能槽共用预制件里作者定的那一个框（曾经按有无技能染成半透明白，
 * 在浅色战斗背景上等于把框画没了，踩过）。
 */

/**
 * 槽位子节点名（**按名字取，不依赖编辑器拖引用** —— 与 `HpBar` 的 `hp_bar` 同一套路）。
 * 预制件 `skills/<槽位>` 下已经摆好了这三个子节点，改名字要同步这里。
 */
const ICON_NODE = 'icon';
const CD_MASK_NODE = 'cd_mask';
const LOCK_NODE = 'lock';

/**
 * 冷却遮罩的填充方向：`+1` = Cocos 正 `fillRange` 的方向，`-1` = 反向。
 * 预制件里 `cd_mask` 是 `FILLED / RADIAL / fillStart=0.25`（从 12 点方向开始），
 * 我们让 `fillRange = 1 → 0` 随时间收缩（1 = 整圈都被遮住 = 刚进冷却）。
 * 想换顺时针/逆时针就把这一个数取反。
 */
const CD_FILL_SIGN = 1;

/**
 * SkillSlot —— **技能栏里的一个技能格子**（内嵌 UI 小组件 → 继承 `UIWidget`，**不加 @uiview**）
 *
 * ── 四条表现口径（对应需求）──
 *   ① **空槽不隐藏、底框常显**：节点 `active` 永远是 true，只把 `icon` 收起来，
 *      **底框是预制件里作者的 Sprite，代码一个字都不改**（"没技能时只是不显示 icon，背景框要留着"）——
 *      因为 `skills` 上的 Layout 会按 active 重排，收起节点会让剩下的格子跳位置，留着空框位置才固定
 *   ② **有技能 → 同步图标**（abilities.json 的 `icon`，没配就回落占位图）+ 等级 + 品质色
 *   ③ **冷却 → 圆形填充**：`cd_mask` 是 `FILLED/RADIAL` 的 Sprite，`fillRange = 冷却进度`（1→0）
 *   ④ **锁定状态**：槽 0 永远显示"锁"（英雄专属技能，不可替换）；槽 1~3 **有技能时**才显示锁图标，
 *      点它切换锁定/解锁（自己不改状态，只 `emit` 给宿主）
 *
 * ── 交互 ──
 *   · **长按**（`LONG_PRESS_SECONDS`）→ `emit(SkillDetailRequested, index)`，由 HUD 弹详情面板
 *   · **长按弹出的面板不因松手而收起**（松手就收 = 常常一帧都没画出来，踩过）；
 *     收起靠「**短按**任意格子」→ `emit(SkillDetailDismissed)`，或在面板上点一下（面板自己处理）
 *   · **点锁图标** → `emit(SkillLockToggled, index)`（在锁节点的 TOUCH_START 里
 *     `propagationStopped = true`，所以点锁不会同时被当成"长按格子"）
 *
 * ── 通信 ──
 *   向下：只 inject 宿主 provide 的**一个门面**（`SkillSlotsVM`：槽位状态 + 冷却进度都从它读，
 *         原来拆成 `SkillSlots` / `SkillCooldowns` 两个裸 ref）
 *   向上：只 `emit`，**不直接改任何状态**（锁定的真源在 `SkillSlots`，只有宿主能改）
 *
 * ⚠ 本组件由 HUD（`View_Game_Stage`）在运行时 `addComponent` 挂到预制件的 4 个槽位节点上，
 *   所以子节点一律按名字取（`@property` 只是给将来编辑器接线留的口子）。
 */
@ccclass('SkillSlot')
export class SkillSlot extends UIWidget {

    /* ===== 编辑器可拖的引用（留空则按下面的节点名在自身子树里找） ===== */
    @property(Sprite)
    iconSprite: Sprite = null;
    @property(Sprite)
    cdMask: Sprite = null;
    @property(Node)
    lockNode: Node = null;
    @property(Label)
    levelLabel: Label = null;

    /**
     * 本格子对应第几个技能槽（0 起）。
     * HUD 逐个下发；`-1`（没下发，例如组件是运行时刚挂上、赋值晚于 `onInit`）时
     * `onInit` 按**兄弟顺序**自推，保证槽位下标永远对得上。
     */
    slotIndex = -1;

    /* 宿主注入的功能门面（槽位状态 / 冷却进度都从它读） */
    private skillSlots: SkillSlotsVM = null;

    /* 运行时解析出来的子节点 */
    private lockSprite: Sprite = null;

    /* 长按状态机（帧驱动，不用 scheduleOnce —— 池化/销毁时不会有残留定时器） */
    private pressing = false;
    private pressTime = 0;
    private longFired = false;

    /** 已加载的图标（同一个路径不重复 load） */
    private iconPath = '';
    private static iconCache: Map<string, SpriteFrame> = new Map<string, SpriteFrame>();
    private static lockSF: SpriteFrame = null;
    private static unlockSF: SpriteFrame = null;

    /* ===================================================================
     * UIWidget 生命周期
     * =================================================================== */

    protected onInit(): void {
        // 下标兜底：HUD 是「addComponent 之后才赋值 slotIndex」的，若本组件的 onInit 已经跑过，
        // 那次 refresh 用的还是默认值 → 这里按兄弟顺序自推，保证下标一定对得上（槽 0 = 英雄专属）
        if (this.slotIndex < 0) this.slotIndex = this.node.getSiblingIndex();

        this.skillSlots = this.inject<SkillSlotsVM>(StageScopeKeys.SkillSlots, null);
        if (!this.skillSlots) {
            ezgame.warn(`[技能槽] 槽 ${this.slotIndex} 没注入到 SkillSlots 门面（不在 Scene_Game_Stage 子树下？），格子不会刷新`);
        }

        this.resolveChildren();

        // 触摸：格子上做长按；锁图标单独处理并**阻断冒泡**（否则点锁会同时触发长按）
        this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        if (this.lockNode) {
            this.lockNode.on(Node.EventType.TOUCH_START, this.onLockTouchStart, this);
            this.lockNode.on(Node.EventType.TOUCH_END, this.onLockTouchEnd, this);
        }

        // watcher 交给 scope：随显示隐藏 resume/pause、销毁自动回收
        this.scope.watch(() => this.skillSlots?.slots.value, () => this.refresh());
        this.scope.watch(() => this.skillSlots?.cooldowns.value, () => this.refreshCooldown());

        this.refresh();
    }

    protected onShow(): void {
        // 每次重新显示都按当前状态刷一遍（技能 id 等是普通字段，watch 补播不到）
        this.refresh();
    }

    protected onHide(): void {
        // 隐藏时把长按状态复位，避免"按住时被隐藏 → 再显示时立刻弹面板"
        this.resetPress();
    }

    protected onDispose(): void {
        // 这些节点都是本组件的后代：销毁时它们先被 _destruct()（字段清空），
        // 直接 off 会抛异常堵死引擎销毁队列 → 一律走 offNodeEvent（已销毁的会被跳过）
        this.offNodeEvent(this.node, Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.offNodeEvent(this.node, Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.offNodeEvent(this.node, Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        this.offNodeEvent(this.lockNode, Node.EventType.TOUCH_START, this.onLockTouchStart, this);
        this.offNodeEvent(this.lockNode, Node.EventType.TOUCH_END, this.onLockTouchEnd, this);
    }

    /**
     * 每帧推进长按计时（`UIComponent` 继承自 `Component`，引擎会把有 `update` 的组件登记进更新列表）。
     * 不用 `scheduleOnce`：那是定时器，池化/销毁时会留下残留回调（同 `HitFlash` / `HpBar` 的口径）。
     */
    update(dt: number): void {
        if (!this.pressing || this.longFired) return;
        this.pressTime += dt;
        if (this.pressTime < LONG_PRESS_SECONDS) return;
        this.longFired = true;

        const skillId = this.currentSkillId();
        if (skillId > 0) {
            // 这条 info 是**交互链路的探针**：长按没反应时先看它有没有打出来
            // （没有 = 触摸事件没到格子；有 = 事件到了，问题在宿主/面板那一段）
            ezgame.info(`[技能槽] 槽 ${this.slotIndex} 长按 ${LONG_PRESS_SECONDS}s → 请求详情（技能 ${skillId}）`);
            this.scope.emit(StageScopeEvents.SkillDetailRequested, this.slotIndex);
        } else {
            // 空槽没有详情可看（底框还在，只是没技能）
            ezgame.info(`[技能槽] 槽 ${this.slotIndex} 长按了但槽里没技能，不弹详情`);
        }
    }

    /* ===================================================================
     * 刷新（只读注入的状态 → 写节点；watch 与该显示的公共出口）
     * =================================================================== */

    /** 按当前槽位状态刷一遍（图标 / 锁 / 冷却）；底框不动（作者的框常显） */
    refresh(): void {
        const state = this.currentState();
        const skillId = state?.skillId ?? 0;

        this.applyIcon(skillId);
        this.applyLevel(state);
        this.applyLock(state, skillId);
        this.refreshCooldown();
    }

    /**
     * 圆形填充模拟冷却：`cd_mask.fillRange = 冷却进度`（1 = 刚进冷却、0 = 冷却结束）。
     * 不在冷却里就把遮罩节点整个收起来（省一次绘制）。
     */
    refreshCooldown(): void {
        if (!this.cdMask) return;
        const ratio = this.skillSlots ? this.skillSlots.cooldownAt(this.slotIndex) : 0;
        const on = ratio > 0.001;
        if (this.cdMask.node) this.cdMask.node.active = on;
        this.cdMask.fillRange = on ? CD_FILL_SIGN * Math.min(1, ratio) : 0;
    }

    /* ===================================================================
     * 表现细节
     * =================================================================== */

    /** 有技能 → 同步图标（没配 `icon` 回落占位图）；空槽 → 只收起图标，底框照旧显示 */
    private applyIcon(skillId: number): void {
        if (!this.iconSprite) return;
        if (skillId <= 0) {
            // 空槽：不显示图标（底框就是"空槽"的视觉），清掉以避免槽位复用留脏图
            this.iconPath = '';
            this.iconSprite.spriteFrame = null;
            if (this.iconSprite.node) this.iconSprite.node.active = false;
            return;
        }

        const cfg = ShopConfig.getAbility(skillId);
        const path = cfg?.icon || PLACEHOLDER_ICON;
        if (this.iconSprite.node) this.iconSprite.node.active = true;

        // 品质色只染**占位图**（现在所有技能都没配 icon，占位图染色至少能看出稀有度）；
        // 真图标不染色 —— Sprite.color 是乘算，会把美术图的颜色压暗/串色。
        this.iconSprite.color = cfg?.icon
            ? new Color(255, 255, 255, 255)
            : new Color(RARITY_COLOR[cfg?.rarity ?? 'common'] ?? RARITY_COLOR.common);

        if (path === this.iconPath) return;
        this.iconPath = path;
        this.loadSpriteFrame(path, (sf) => {
            if (this.iconSprite?.isValid && this.iconPath === path) this.iconSprite.spriteFrame = sf;
        });
    }

    /** 等级（可选节点）：多级技能才显示；单位技能 `max_level=1` 不显示 */
    private applyLevel(state: SkillSlotState): void {
        if (!this.levelLabel?.node) return;
        const skillId = state?.skillId ?? 0;
        const cfg = skillId > 0 ? ShopConfig.getAbility(skillId) : undefined;
        const max = cfg ? ShopConfig.getSkillMaxLevel(cfg) : 1;
        const show = !!cfg && max > 1;
        this.levelLabel.node.active = show;
        if (show) this.levelLabel.string = `Lv.${state.level}/${max}`;
    }

    /**
     * 锁定状态：
     *   · 槽 0（英雄专属技能）→ **永远显示锁**（不可解锁，点了会飘字提示）
     *   · 槽 1~3 → **只在有技能时显示**：锁图标 = 已锁定 / 开锁图标 = 未锁定
     *   · 空槽的槽 1~3 → 不显示（需求：其他 3 个槽位"有技能时需要显示是否锁定"）
     */
    private applyLock(state: SkillSlotState, skillId: number): void {
        if (!this.lockNode) return;
        const isHeroSlot = this.slotIndex === 0;
        const show = isHeroSlot || skillId > 0;
        this.lockNode.active = show;
        if (!show) return;

        const locked = state?.locked ?? isHeroSlot;
        this.loadLockSprite(locked);
    }

    /** 锁 / 开锁两张图（静态缓存，只加载一次） */
    private loadLockSprite(locked: boolean): void {
        const sprite = this.lockSprite;
        if (!sprite) return;
        const cached = locked ? SkillSlot.lockSF : SkillSlot.unlockSF;
        if (cached) {
            sprite.spriteFrame = cached;
            return;
        }
        const path = locked ? LOCK_ICON : UNLOCK_ICON;
        this.loadSpriteFrame(path, (sf) => {
            if (locked) SkillSlot.lockSF = sf;
            else SkillSlot.unlockSF = sf;
            if (!sprite.isValid) return;
            // 加载期间锁状态可能又变了：以**当前**状态为准，不用闭包里的 locked
            const nowLocked = this.currentState()?.locked ?? (this.slotIndex === 0);
            if (nowLocked === locked) sprite.spriteFrame = sf;
        });
    }

    /* ===================================================================
     * 触摸：长按弹详情 / 点锁切锁定
     * =================================================================== */

    private onTouchStart(): void {
        this.pressing = true;
        this.pressTime = 0;
        this.longFired = false;
        // 探针：按下去就该有一条（没有 = 触摸事件压根没到格子节点）
        ezgame.info(`[技能槽] 按住槽 ${this.slotIndex}（技能 ${this.currentSkillId()}，锁定 ${this.currentState()?.locked ?? false}）`);
    }

    /**
     * 松手：
     *   · **长按弹出来的面板不因松手而收起** —— 面板要"能看清、能读完"。
     *     ⚠ 踩过：曾经松手即收起，而玩家通常在刚到 0.4s 门槛时就松手 →
     *     `show()` 与 `hide()` 落在同一帧里，**面板一帧都没画出来**（日志看得到 show，画面什么都没有）。
     *   · 短按（没到长按门槛）= "点一下别处"，用来收起已弹出的面板。
     */
    private onTouchEnd(): void {
        const wasLongPress = this.longFired;
        this.resetPress();
        if (!wasLongPress) this.scope.emit(StageScopeEvents.SkillDetailDismissed);
    }

    /** 触摸被系统取消（离开屏幕/被别的控件抢走）：长按态复位，并收起面板 */
    private onTouchCancel(): void {
        this.resetPress();
        this.scope.emit(StageScopeEvents.SkillDetailDismissed);
    }

    private resetPress(): void {
        this.pressing = false;
        this.pressTime = 0;
        this.longFired = false;
    }

    /** 按在锁图标上：阻断冒泡，别让格子把它当成"开始长按" */
    private onLockTouchStart(event: { propagationStopped: boolean }): void {
        if (event) event.propagationStopped = true;
        this.resetPress();
    }

    /** 点锁图标 = 锁定/解锁（本组件只上报，改状态的是宿主 `SkillSlots.toggleLock`） */
    private onLockTouchEnd(event: { propagationStopped: boolean }): void {
        if (event) event.propagationStopped = true;
        this.resetPress();
        this.scope.emit(StageScopeEvents.SkillLockToggled, this.slotIndex);
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** 当前槽位状态（门面没注入到 → null；越界由门面的 `slotAt` 兜成空槽） */
    private currentState(): SkillSlotState | null {
        return this.skillSlots ? this.skillSlots.slotAt(this.slotIndex) : null;
    }

    private currentSkillId(): number {
        return this.currentState()?.skillId ?? 0;
    }

    /** 按名字解析子节点（预制件 `skills/<槽位>` 下已有，没拖引用时用这条） */
    private resolveChildren(): void {
        const iconNode = this.iconSprite ? this.iconSprite.node : this.node.getChildByName(ICON_NODE);
        if (iconNode && !this.iconSprite) this.iconSprite = iconNode.getComponent(Sprite);
        const cdNode = this.cdMask ? this.cdMask.node : this.node.getChildByName(CD_MASK_NODE);
        if (cdNode && !this.cdMask) this.cdMask = cdNode.getComponent(Sprite);
        if (!this.lockNode) this.lockNode = this.node.getChildByName(LOCK_NODE);
        this.lockSprite = this.lockNode ? this.lockNode.getComponent(Sprite) : null;

        // 底框不解析也不写（常显，见类头 ①）；这里只兜住"连图标都没有"的结构性问题
        if (!this.iconSprite) ezgame.warn(`[技能槽] 槽 ${this.slotIndex} 找不到 ${ICON_NODE} 子节点，技能图标不会显示`);
        if (!this.cdMask) ezgame.warn(`[技能槽] 槽 ${this.slotIndex} 找不到 ${CD_MASK_NODE} 子节点，冷却圈不会显示`);
    }

    /** 加载 `path/spriteFrame`（resources 内置资源；静态缓存，失败只报错不动节点） */
    private loadSpriteFrame(path: string, onLoaded: (sf: SpriteFrame) => void): void {
        if (!path) return;
        const cached = SkillSlot.iconCache.get(path);
        if (cached) {
            onLoaded(cached);
            return;
        }
        resources.load(`${path}/spriteFrame`, SpriteFrame, (err, sf) => {
            if (err || !sf) {
                ezgame.error(`[技能槽] 图标加载失败：${path}`, err);
                return;
            }
            SkillSlot.iconCache.set(path, sf);
            onLoaded(sf);
        });
    }
}
