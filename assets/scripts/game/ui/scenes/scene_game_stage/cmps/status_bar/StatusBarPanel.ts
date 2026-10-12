import { _decorator, Color, Label, Node, Sprite, SpriteFrame, UIOpacity, UITransform, resources } from 'cc';
import { UIWidget } from 'db://assets/scripts/platform/ui/UIWidget';
import { AtlasIcon } from '../../../../../common/AtlasIcon';
import { StageScopeKeys } from '../StageScope';
import type { StatusBarEntry, StatusBarVM } from '../../../../../battle/StatusBar';

const { ccclass } = _decorator;

/**
 * 状态栏的宿主节点名（预制件 `View_Game_Stage/buff_status`，12 个 `buff*` 子节点已摆好）
 */
const STATUS_BAR_NODE = 'buff_status';

/** 运行时给每格加的文本子节点名（预制件里**没有** Label，只有 Sprite + Button） */
const CHIP_TEXT_NODE = 'text';

/**
 * 只用**第一行**的 10 格。
 *
 * 预制件里 12 格排成两行（前 10 格 `y = -2.5`，最后两格 `y = +27.5`）；第二行那两格
 * 会压到 `item_bags` 展开后的 6 格上（`audit:itembag` 的 B19 就是量的这里），
 * 而且 10 格已经够用（英雄身上同时存在的状态实测 ≤ 6，见 `docs/status-bar/README.md` §2），
 * 所以本组件把第 11、12 格**显式收起**（它们在预制件里默认是 active 的，不收起来
 * 开局就顶着两块空白占位图）。要 12 格就把那一行挪开再改这个常量。
 */
const USED_SLOTS = 10;

/** 底色 · 负面（token `c-hit-hero` #FF4C4C；与「英雄受击闪 / 英雄飘字色」同一个红） */
const DEBUFF_BG = new Color(255, 76, 76, 255);
/** 底色 · 正面（token `c-accent-400` #70ACB3；与技能格 / 武器格底同色） */
const BUFF_BG = new Color(112, 172, 179, 255);
/** 文字（token `c-text-on-dark` #FFFFFF） */
const TEXT_COLOR = new Color(255, 255, 255, 255);

/**
 * **有图标时**格子底图不染色（token `c-text-on-dark` #FFFFFF = 原色）。
 *
 * 为什么不像色块那样染成"负面红 / 正面青绿"：来源图标（遗物 / 技能图集）本身就是彩色的识别物，
 * 染一层色等于把它糊掉 —— 玩家认的是那张图。是正是负由**图本身 + 点开的说明面板**回答
 * （无图的行才退回色块那条路，色块仍然按正负染色）。
 */
const ICON_TINT = new Color(255, 255, 255, 255);

/**
 * 值文字的描边（token `c-damage-outline` #14181B —— 全工程"白字压在图上"就用它，见 `FloatText`）。
 * 只在**有图标**时开：这时候 12px 的白字直接压在图上，不描边读不清；
 * 无图标时是白字压纯色块，不需要描边（多一层渲染开销）。
 */
const TEXT_OUTLINE = new Color(20, 24, 27, 255);
/** 描边宽度：`FloatText` 同值 2（12px 字压在**图**上，1px 压不住；art-style 的 ×0.12 是"浅底"用的） */
const TEXT_OUTLINE_WIDTH = 2;

/** 字号（token `micro` = 12）与行距（**= 字号**，与 `audit:ui` 的行距口径一致） */
const TEXT_SIZE = 12;
const TEXT_LINE = 12;

/** 剩余多少秒开始闪（"快没了"的统一提示——25px 的格子塞不下进度条） */
const BLINK_SECONDS = 2;
/** 闪烁频率（Hz）与最暗不透明度 */
const BLINK_HZ = 4;
const BLINK_ALPHA_MIN = 90;

/* ===================================================================
 * 点击说明面板（2026-11 新增；用户口径「状态点击后需要弹出说明面板」）
 *
 * ---- 为什么是**运行期建节点**而不是改预制件 ----
 *   预制件是「扁平数组 + 按下标 __id__ 互相引用」，手工插对象会让后面所有下标顺移
 *   （`tools/prefab-diff` 的 README 有实测：改 3 个字段能出 1173 个 hunk）。
 *   本组件已经有"运行期给每格补 `text` 子节点"的先例（预制件里那 12 格只有 Sprite + Button），
 *   面板照同一条路走：**零预制件改动**，且尺寸/位置全部从现有节点**现读**。
 *
 * ---- 位置怎么定（不写死坐标） ----
 *   锚在**状态栏这一行的左上角**、并向上让开一段。行左上角从 10 个格子的实际位置现算
 *   （`buildChips` 里顺手记下），所以预制件把这一行挪走时面板会跟着走，不会飘到别处。
 * =================================================================== */

/** 说明面板的节点名（运行期建；`onDispose` 自己销毁） */
const TIP_NODE = 'status_tip';
/** 面板尺寸（像素）：宽 300 装得下 30 个汉字（字号 16 → 约 33 字/行） */
const TIP_WIDTH = 300;
/**
 * 面板高度：标题一行（20）+ 正文两行（18×2）+ 上下留白 → 78。
 * 正文框给两行是刻意的：`desc` 建议 ≤30 汉字，但配表写长了必须有地方放
 * （超出的字由 `Label.Overflow.CLAMP` 裁掉，**不许把面板撑破**）。
 */
const TIP_HEIGHT = 78;
/** 面板底边与状态栏行之间的间隙 */
const TIP_GAP = 8;
/** 内边距（左/右）与标题基线 */
const TIP_PAD_X = 12;
const TIP_TITLE_TOP = 8;
const TIP_TITLE_H = 22;

/** 面板底色（token `c-surface` #FFFFFF，α 240 —— 只压一层薄白，底下的战场还看得见轮廓） */
const TIP_BG = new Color(255, 255, 255, 240);
/** 标题色（token `c-ink-900` #445054） */
const TIP_TITLE_COLOR = new Color(68, 80, 84, 255);
/** 正文色（token `c-ink-600` #6A696B） */
const TIP_BODY_COLOR = new Color(106, 105, 107, 255);
/** 标题字号（token `body` = 16）与正文（token `caption` = 14）+ 行距 20 */
const TIP_TITLE_SIZE = 16;
const TIP_BODY_SIZE = 14;
const TIP_LINE_HEIGHT = 20;
/**
 * 面板自动收起的秒数。
 *
 * 为什么需要：这一层**没有全屏遮罩**（有遮罩就点不了 HUD 了），所以"点别处关掉"这条路不存在 ——
 * 不给超时的话，一块说明会一直挂在那儿，只能再点一次那一格才清掉。
 * 取 8 秒：够读完两行说明，又短到不会挡住战场太久。
 */
const TIP_AUTO_HIDE_SEC = 8;

/** 一格需要的运行时引用 */
interface ChipRefs {
    node: Node;
    sprite: Sprite;
    label: Label;
    opacity: UIOpacity;
    /** 上一次写进 Label 的文本（一样就不写 —— 每帧写会白跑一次排版） */
    text: string;
    /** 上一次设过 `enableOutline` 的值（图标模式才描边；每帧重设会白跑一次渲染态切换） */
    outlined: boolean;
    /** 已经**发起过加载**的图标路径（空 = 走"色块 + 短标"）—— 加载失败也不重试，见 `loadChipIcon` */
    iconRequested: string;
    /** 真正**用上了**的图标路径（加载成功才有值；空 = 这一格照色块画） */
    icon: string;
    /** 点击时对应的条目（`refresh` 每帧原地更新；`onDispose` 要摘监听） */
    entry: StatusBarEntry | null;
}

/** 说明面板的运行时引用（整块只在第一次点击时建一次） */
interface TipRefs {
    node: Node;
    title: Label;
    body: Label;
}

/**
 * StatusBarPanel —— **HUD 状态栏**（英雄头像 + HP/EXP 条下方那一行）的绘制组件
 *
 * ```
 * buff_status/                    ← 本组件挂在这个节点上（HUD 的 onInit 里 addComponent）
 *   ├─ buff        ┐
 *   ├─ buff-001    │ 第一行 10 格（25×25 Sprite + Button，预制件里作者摆好的）
 *   ├─ …           │ 运行期每格加一个 `text` 子节点（Label：上行短标 / 下行值）
 *   ├─ buff-009    ┘
 *   └─ buff-010/011   ← 第二行两格：**显式收起**（会压到 item_bags 展开区，见 USED_SLOTS 注释）
 * ```
 *
 * ── 分工（与 `item_bag/` 同一套口径）──
 *   · **该显示什么、怎么排序、同键怎么合并、取哪张图标** → `battle/StatusBar.ts`（纯 TS，宿主 provide 的门面）
 *   · **怎么画** → 本组件：有图标画「来源图标 + 值」；没有才画「色块（负面红 / 正面青绿）+ 短标 + 值」
 *   · **状态的真源** → 英雄实体身上的 Modifier 实例（本组件一个字都不缓存）
 *
 * ── 为什么每帧读而不是订阅事件 ──
 *   倒计时每帧都在变，`OnModifierAdded/Removed` 那三条事件只能回答"增删了"，
 *   回答不了"还剩几秒"。英雄身上的实例数是个位数，每帧遍历一次比维护事件账本更简单、也更不容易漏。
 *   代价：Label 只在文本真的变了的时候才写（`text` 做缓存），闪烁才逐帧改 `UIOpacity`。
 *
 * ── 一枚格子画什么（2026-11 起**有图标就走图标**）──
 * ```
 *   有来源图标（entry.icon 非空）        没有来源图标
 *   ┌────────┐                          ┌────────┐
 *   │  遗物   │ ← 来源配表的图，不染色      │  燃烧  │ ← 色块：负面红 / 正面青绿
 *   │   3    │ ← 只写「值」，白字 + 描边    │   3    │ ← 两行：短标 + 值
 *   └────────┘                          └────────┘
 * ```
 * 图标**不是状态栏自己的素材** —— 它来自状态的**来源**（遗物 → `relics.icon`、技能 → `abilities.icon`、
 * 药水 → `battle_items.icon`），取不到才退到这一行 Modifier 的 `icon`（buff 图标）。
 * 取路径的判据在 `battle/StatusBar.ts`（纯 TS），本组件只负责 `AtlasIcon` 加载 + 画。
 *
 * ── 素材现状（2026-11）──
 *   `relics.icon` 277/277 有图、商店技能 `abilities.icon` 30/30 有图（10 件「连击」遗物的图
 *   都实测在 `textures/relics/relics.plist` 里）⇒ 8 个遗物载体行 + 3 个技能行**直接复用已有图集**；
 *   药水（`battle_items.icon` 全空）与 4 个怪物 debuff（`modifiers.icon` 全空）暂时仍画色块 + 短标，
 *   哪一行补上 `icon` 列就自动出图（不用改代码）。
 */
@ccclass('StatusBarPanel')
export class StatusBarPanel extends UIWidget {

    /** 宿主注入的状态栏门面（采集规则在 `battle/StatusBar.ts`） */
    private statusBar: StatusBarVM = null;

    private chips: ChipRefs[] = [];

    /** 本组件自己的时钟（闪烁用；不用 `Date.now` —— 那是墙钟） */
    private clock = 0;

    /** 点击说明面板（**懒建**：没人点就一个节点都不建） */
    private tip: TipRefs | null = null;

    /** 状态栏这一行的左上角（`buildChips` 从 10 格的实际位置现算；说明面板锚在它上面） */
    private rowLeft = 0;
    private rowTop = 0;

    /** 圆角底图（`textures/common/rect_rd_5`，静态缓存只加载一次） */
    private static chipFrame: SpriteFrame = null;

    /* ===================================================================
     * UIWidget 生命周期
     * =================================================================== */

    protected onInit(): void {
        this.statusBar = this.inject<StatusBarVM>(StageScopeKeys.StatusBar, null);
        if (!this.statusBar) {
            ezgame.warn('[状态栏] 没注入到 StatusBar 门面（不在 Scene_Game_Stage 子树下？），格子不会刷新');
        }
        this.loadChipFrame();
        this.buildChips();
        this.refresh();
    }

    protected onShow(): void {
        // 每局开局按当前状态刷一遍（上一局残留的格子不能带到这一局）
        this.clock = 0;
        this.hideTip();     // 说明面板也要收：换局时上一局点开的那块不能留在屏幕上
        this.refresh();
    }

    protected onDispose(): void {
        // ⚠ 文本子节点与说明面板都是**运行时建的**，不在预制件里 —— 收尾自己销毁，别留孤儿节点。
        //   这里只用 `?.node` 走节点 API，不碰别的组件（onDestroy 里碰组件会堵死引擎销毁队列）。
        for (const c of this.chips) {
            c.entry = null;
            const text = c.node?.getChildByName?.(CHIP_TEXT_NODE);
            if (text?.isValid) text.destroy();
        }
        this.chips.length = 0;
        if (this.tip?.node?.isValid) this.tip.node.destroy();
        this.tip = null;
    }

    /**
     * 每帧推进：**先采集再画**。
     * 10 个格子的开销 = 一次遍历（英雄身上个位数实例）+ ≤10 次字符串比较，
     * 比"订阅事件 + 自己维护倒计时账本"少一整类漏刷 bug。
     */
    update(dt: number): void {
        this.clock += dt;
        // 说明面板自动收起（没有全屏遮罩可以"点外面关掉"，所以给一个超时兜底 ——
        // 否则一块说明会一直挂在战场上，玩家还得再点一次那一格才能清掉）
        if (this.tipRemain > 0) {
            this.tipRemain -= dt;
            if (this.tipRemain <= 0) this.hideTip();
        }
        this.refresh();
    }

    /* ===================================================================
     * 画
     * =================================================================== */

    /** 按本帧采到的条目重画 10 格（多余的格子收起） */
    refresh(): void {
        const entries = this.statusBar ? this.statusBar.read() : [];
        for (let i = 0; i < this.chips.length; i++) {
            this.applyChip(this.chips[i], i < entries.length ? entries[i] : null);
        }
    }

    private applyChip(chip: ChipRefs, entry: StatusBarEntry | null): void {
        if (!chip.node?.isValid) return;

        if (!entry) {
            if (chip.node.active) chip.node.active = false;
            chip.entry = null;
            return;
        }
        chip.node.active = true;
        // 点击时读的就是这一份（`StatusBar.read()` 的对象是**复用**的，所以只存引用不拷贝）
        chip.entry = entry;

        // ① 图标（2026-11）：来源配表的图标由 `battle/StatusBar.ts` 取好（`entry.icon`）。
        //    只在**来源真的变了**的时候发起加载（`iconRequested` 把关）—— 每帧 load 会白跑。
        if (entry.icon !== chip.iconRequested) this.loadChipIcon(chip, entry.icon);
        const hasIcon = !!chip.icon;

        // ② 底：有图标 → 图标当底（**不染色**，玩家认的是那张图）；没图标 → 色块（负面红 / 正面青绿）
        chip.sprite.color = hasIcon ? ICON_TINT : (entry.isDebuff ? DEBUFF_BG : BUFF_BG);

        // ③ 文本：有图标时**只写"值"**（图标已经回答了"这是什么"；25px 里两行字压图读不清）；
        //    没图标才补上短标那一行（现状画法）
        const text = hasIcon ? chipValueText(entry) : `${entry.label}\n${chipValueText(entry)}`;
        if (chip.label && chip.text !== text) {
            chip.label.string = text;
            chip.text = text;
        }
        if (chip.label && chip.outlined !== hasIcon) {
            // 值字靠底边（图上沿通常是主体）、白字加描边（不然 12px 压在花花的图上读不出来）
            chip.label.enableOutline = hasIcon;
            chip.label.outlineColor = TEXT_OUTLINE;
            chip.label.outlineWidth = TEXT_OUTLINE_WIDTH;
            chip.label.verticalAlign = hasIcon ? Label.VerticalAlign.BOTTOM : Label.VerticalAlign.CENTER;
            chip.outlined = hasIcon;
        }

        // ④ 快没了就闪（<2 秒）；否则恒为不透明 —— 收尾那一帧一定复位，别把透明度带进下一局
        chip.opacity.opacity = blinkAlpha(entry, this.clock);

        // ⑤ 面板开着的那一格跟着刷新（说明里写着"还剩 N 秒"，不跟着会读到过期的数）
        if (this.tip?.node?.active && this.tipEntry === entry) this.writeTip(entry);
    }

    /* ===================================================================
     * 点击说明面板
     * =================================================================== */

    /** 当前面板正在说明的那一条（引用比较即可 —— `read()` 返回的是复用对象） */
    private tipEntry: StatusBarEntry | null = null;

    /** 面板自动收起倒计时（秒；0 = 没开） */
    private tipRemain = 0;

    /**
     * 点某一格：**同一格再点 = 收起**，换一格 = 换成那一条（并重新计时）。
     *
     * 判据只能靠 `tipEntry === entry`：格子上的 `entry` 是 `StatusBar.read()` 每帧
     * **原地复写**的同一个对象，所以"同一条状态"在这里天然等于同一个引用。
     */
    private openTipFor(chip: ChipRefs): void {
        const entry = chip.entry;
        if (!entry) return;                        // 空格子（收起的格）点了不该有反应
        if (this.tip?.node?.active && this.tipEntry === entry) {
            this.hideTip();
            return;
        }
        const tip = this.ensureTip();
        if (!tip) return;
        this.tipEntry = entry;
        this.writeTip(entry);
        this.tipRemain = TIP_AUTO_HIDE_SEC;
        // 置顶：新开的面板要压在其它 HUD 元素之上（说明面板是"临时焦点"）
        const parent = this.node.parent;
        if (parent) tip.node.setSiblingIndex(parent.children.length - 1);
        tip.node.active = true;
    }

    /** 收起面板（再点同一格 / 超时 / 换局 / 本组件销毁） */
    hideTip(): void {
        this.tipEntry = null;
        this.tipRemain = 0;
        if (this.tip?.node?.isValid) this.tip.node.active = false;
    }

    /** 把一条状态写进面板（标题 = 全名 + 状态摘要；正文 = 配表说明 / 兜底句） */
    private writeTip(entry: StatusBarEntry): void {
        const tip = this.tip;
        if (!tip) return;
        const tail = tipSummary(entry);
        tip.title.string = tail ? `${entry.name}　${tail}` : entry.name;
        tip.body.string = entry.desc || '（这条状态没有配说明）';
    }

    /**
     * 懒建说明面板（只在第一次点格子时建一次）。
     *
     * 节点结构（全部运行期建，预制件一行不改）：
     * ```
     * buff_status/
     *   ├─ buff … buff-009      10 个格子
     *   └─ status_tip           说明面板（300×78，锚在状态栏行的左上方）
     *        ├─ title           标题（全名 + 层数/剩余时间）
     *        └─ body            正文（配表 desc）
     * ```
     * 位置从 `rowLeft/rowTop` 现算（见 `buildChips`），所以预制件挪动这一行时面板跟着走。
     */
    private ensureTip(): TipRefs | null {
        if (this.tip?.node?.isValid) return this.tip;

        const node = new Node(TIP_NODE);
        node.layer = this.node.layer;
        this.node.addChild(node);
        // 锚点 (0,0) = 左下角：`rowLeft/rowTop` 就是这一行的左上角，位置一减就对齐了
        node.setPosition(this.rowLeft, this.rowTop + TIP_GAP, 0);
        const ui = node.addComponent(UITransform);
        ui.setContentSize(TIP_WIDTH, TIP_HEIGHT);
        ui.setAnchorPoint(0, 0);

        const sprite = node.addComponent(Sprite);
        if (StatusBarPanel.chipFrame) sprite.spriteFrame = StatusBarPanel.chipFrame;
        sprite.type = Sprite.Type.SLICED;
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.color = TIP_BG;

        const title = this.makeTipLabel(node, 'title', TIP_TITLE_SIZE, TIP_TITLE_COLOR, TIP_HEIGHT - TIP_TITLE_TOP - TIP_TITLE_H, TIP_TITLE_H);
        const body = this.makeTipLabel(node, 'body', TIP_BODY_SIZE, TIP_BODY_COLOR, TIP_TITLE_TOP, TIP_HEIGHT - TIP_TITLE_TOP - TIP_TITLE_H - 6);
        if (!title || !body) {
            // 建不出来（引擎异常）→ 整块拆掉，绝不留下一个半成品节点
            node.destroy();
            return null;
        }
        node.active = false;
        this.tip = { node, title, body };
        // ⚠ 底图可能还在异步加载中（`loadChipFrame` 的回调里会把 tip 的 spriteFrame 一起补上），
        //   这里**不要**再调一次 loadChipFrame —— 那会并发起第二次 `resources.load`
        return this.tip;
    }

    /** 面板里的一行 Label（左对齐 + CLAMP：写长了裁掉，**不许把面板撑破**） */
    private makeTipLabel(parent: Node, name: string, size: number, color: Color, bottom: number, height: number): Label | null {
        const n = new Node(name);
        n.layer = parent.layer;
        parent.addChild(n);
        n.setPosition(TIP_PAD_X, bottom, 0);
        const ui = n.addComponent(UITransform);
        ui.setContentSize(TIP_WIDTH - TIP_PAD_X * 2, height);
        ui.setAnchorPoint(0, 0);
        const label = n.addComponent(Label);
        label.string = '';
        label.fontSize = size;
        label.lineHeight = TIP_LINE_HEIGHT;
        label.color = color;
        label.horizontalAlign = Label.HorizontalAlign.LEFT;
        label.verticalAlign = Label.VerticalAlign.TOP;
        label.overflow = Label.Overflow.CLAMP;
        label.enableWrapText = true;
        return label;
    }

    /* ===================================================================
     * 内部
     * =================================================================== */

    /** 预制件的 12 个 `buff*` 子节点 → 运行时格子（前 10 个能用，后 2 个显式收起） */
    private buildChips(): void {
        const kids = this.node.children;
        if (kids.length < USED_SLOTS) {
            ezgame.warn(`[状态栏] 预制件里 \`${STATUS_BAR_NODE}\` 只有 ${kids.length} 个子节点（要 ${USED_SLOTS} 个），状态栏画不全`);
        }

        let left = Infinity;
        let top = -Infinity;
        for (let i = 0; i < kids.length; i++) {
            const node = kids[i];
            if (i >= USED_SLOTS) { node.active = false; continue; }   // 第二行两格：会压到背包展开区

            const sprite = node.getComponent(Sprite);
            const label = this.ensureLabel(node);
            const opacity = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
            if (!sprite || !label) {
                node.active = false;
                ezgame.warn(`[状态栏] 第 ${i + 1} 格缺 ${sprite ? 'Label' : 'Sprite'}，这一格不显示`);
                continue;
            }
            // 底图换成项目统一的圆角块（预制件里引的是 `textures/buffs/冰冻.png` —— 那张是空白占位图，
            // 染色后仍是"糊的"；圆角块才是 token 里 radius-s 的那张）
            if (StatusBarPanel.chipFrame) sprite.spriteFrame = StatusBarPanel.chipFrame;
            sprite.type = Sprite.Type.SLICED;
            sprite.sizeMode = Sprite.SizeMode.CUSTOM;

            node.active = false;      // 本轮没有状态就先不显示（预制件里 12 格默认全是 active 的）
            const chip: ChipRefs = {
                node, sprite, label, opacity,
                text: '', outlined: false, iconRequested: '', icon: '', entry: null,
            };
            this.chips.push(chip);

            // 行的包围盒（说明面板锚在它的左上角）—— 从**实际节点**现读，不写死坐标
            const ui = node.getComponent(UITransform);
            const w = ui ? ui.width : 25;
            const h = ui ? ui.height : 25;
            if (node.position.x - w * 0.5 < left) left = node.position.x - w * 0.5;
            if (node.position.y + h * 0.5 > top) top = node.position.y + h * 0.5;

            // 点击 → 弹说明面板（预制件里每格本来就带 Button，但这里有 10 个格子要挂同一件事，
            // 用节点触摸事件比逐个取 Button 再 listen 短，也不依赖 Button 组件是否在）
            // ⚠ 用闭包抓**局部变量 chip**（不是 `this.chips[len-1]`）：后者会在格子重排后指错那一格
            node.on(Node.EventType.TOUCH_END, () => this.openTipFor(chip), this);
        }
        this.rowLeft = Number.isFinite(left) ? left : 0;
        this.rowTop = Number.isFinite(top) ? top : 0;
    }

    /**
     * 给一格补上文本子节点（预制件里没有 Label，只有 Sprite + Button）。
     * 尺寸**从节点现读**（不写死 25）—— 改版式只动预制件。
     */
    private ensureLabel(node: Node): Label {
        const ui = node.getComponent(UITransform);
        const width = ui ? ui.width : 25;
        const height = ui ? ui.height : 25;

        const existing = node.getChildByName(CHIP_TEXT_NODE);
        if (existing) return existing.getComponent(Label);

        const textNode = new Node(CHIP_TEXT_NODE);
        textNode.layer = node.layer;
        node.addChild(textNode);
        textNode.setPosition(0, 0, 0);
        const tui = textNode.addComponent(UITransform);
        tui.setContentSize(width, height);

        const label = textNode.addComponent(Label);
        label.string = '';
        label.fontSize = TEXT_SIZE;
        // ⚠ 行距只许 0 / = 字号 / round(字号 × 1.5)：这里用「= 字号」，
        //   两行正好 24px，塞进 25px 的格子里不裁字
        label.lineHeight = TEXT_LINE;
        label.color = new Color(TEXT_COLOR);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.CLAMP;   // 超了宁可裁，也不许撑破格子
        label.enableWrapText = false;            // 换行由 '\n' 控制，短标不该自动折行
        return label;
    }

    /**
     * 换一格的底图（**只在 `entry.icon` 变了的时候调**，由 `iconRequested` 把关）。
     *
     * 三条口径：
     *   · **空路径** → 回到项目统一的圆角块（`textures/common/rect_rd_5`）+ `SLICED` + 两行文本；
     *   · **有路径** → 走**全工程共用**的 `AtlasIcon.loadIconFrame`（图集本体 → 帧子资源 → 旧碎图三级降级，
     *     外加按路径缓存）。⚠ **不要**在这里自己 `resources.load(<path>/spriteFrame)` ——
     *     遗物 / 技能图标都在**图集**里（`textures/relics/relics.plist` 那一对），直取碎图路径一律取不到；
     *   · **加载失败**（路径写错 / 图集里没这张帧）→ **不重试**（`iconRequested` 已经记住了这次尝试），
     *     这一格继续按「色块 + 短标」画 —— 绝不能留下"空白底 + 半截文字"的格子。
     */
    private loadChipIcon(chip: ChipRefs, path: string): void {
        chip.iconRequested = path;
        chip.icon = '';                       // 在途/失败都算"还没用上"
        const sprite = chip.sprite;
        if (!sprite?.isValid) return;

        if (!path) {
            sprite.type = Sprite.Type.SLICED;
            sprite.spriteFrame = StatusBarPanel.chipFrame;
            return;
        }
        AtlasIcon.loadIconFrame(path).then((sf) => {
            // 期间这一格换了来源 / 组件已销毁 → 结果作废（否则会把别人的图标画到自己身上）
            if (!sf || !sprite.isValid || chip.iconRequested !== path) return;
            chip.icon = path;
            // 图标是方形彩图，不能走 SLICED（九宫格会把图切坏）——用 SIMPLE 铺满 25×25
            sprite.type = Sprite.Type.SIMPLE;
            sprite.spriteFrame = sf;
        });
    }

    private loadChipFrame(): void {
        if (StatusBarPanel.chipFrame) return;
        resources.load('textures/common/rect_rd_5/spriteFrame', SpriteFrame, (err, sf) => {
            if (err || !sf) {
                // 加载失败就沿用预制件里那张占位图（染色后仍能看出"有这么一格"），不报错到刷屏
                ezgame.warn('[状态栏] 圆角底图加载失败，沿用预制件占位图', err);
                return;
            }
            StatusBarPanel.chipFrame = sf;
            for (const c of this.chips) {
                // ⚠ **已经有来源图标的格子不许被圆角块顶掉**（底图是异步回来的，可能晚于图标）
                if (c.sprite?.isValid && !c.icon) c.sprite.spriteFrame = sf;
            }
            // 说明面板的底图也跟着补（它可能是在底图到位**之前**就点开的）
            const tipSprite = this.tip?.node?.getComponent?.(Sprite);
            if (tipSprite?.isValid) tipSprite.spriteFrame = sf;
        });
    }
}

/**
 * 格子下行那行字：**层数 > 剩余秒数 > ✓**。
 *
 * 为什么层数优先：`连击 ×3` 比 `连击 3`（秒）更该被看到 —— 秒数只在"快没了"时有信息量，
 * 而"快没了"由闪烁（`blinkAlpha`）表达。就绪态（没有秒数也没有层数）画 `✓`。
 */
export function chipValueText(entry: StatusBarEntry): string {
    if (entry.stacks > 1) return `×${Math.min(99, Math.floor(entry.stacks))}`;
    if (entry.seconds >= 0) return `${Math.min(99, Math.max(1, Math.ceil(entry.seconds)))}`;
    return '✓';
}

/** 快没了就闪：剩余 ≤ `BLINK_SECONDS` 的条目按 `BLINK_HZ` 脉动，其余恒为不透明 */
export function blinkAlpha(entry: StatusBarEntry, clock: number): number {
    const seconds = entry.seconds;
    if (entry.stacks > 1) return 255;                      // 层数型没有倒计时
    if (!(seconds >= 0) || seconds > BLINK_SECONDS) return 255;
    const phase = 0.5 + 0.5 * Math.cos(clock * Math.PI * 2 * BLINK_HZ);
    return Math.round(BLINK_ALPHA_MIN + (255 - BLINK_ALPHA_MIN) * phase);
}

/**
 * 说明面板**标题后面**那段摘要：「×3 层」/「还剩 12 秒」/「就绪」，都没有时返回空串。
 *
 * 与格子下行那行字（`chipValueText`）共用同一套优先级（层数 > 秒数 > ✓），
 * 只是**写全**而不是缩写 —— 面板里有地方，不必再省字。
 */
export function tipSummary(entry: StatusBarEntry): string {
    if (entry.stacks > 1) return `×${Math.floor(entry.stacks)} 层`;
    if (entry.seconds >= 0) return `还剩 ${Math.max(1, Math.ceil(entry.seconds))} 秒`;
    return '就绪';
}
